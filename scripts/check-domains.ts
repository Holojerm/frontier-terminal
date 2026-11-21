// Domain boundary gate: `bun run domains:check`, in `bun run ci` and `ci:fast`.
//
// Product code is split into Nuxt layers by business domain on a shared `core`
// (AGENTS.md › Directory Structure). Nuxt doesn't stop one layer reaching into
// another: a relative path, `#layers/<name>/…` and `~~/layers/…` all resolve,
// and every layer's server/utils, shared/utils and shared/types are
// auto-imported into every other. So this fails on:
//
//   - an import, explicit or auto, against the direction in domains.config.ts
//     (core imports no other fork-owned layer), or of a domain file that is not
//     on that domain's public list;
//   - a server/utils, shared/utils or shared/types export name defined by two
//     owners (the app or a layer): Nuxt keeps one and drops the other silently;
//   - the same for app/utils and app/composables names (a .vue file's script
//     and template both count);
//   - a component a layer's .vue file names that is registered by a layer it
//     doesn't use, or a component name two owners register (the later layer wins);
//   - a `uses` entry the layer never imports, auto-imports or renders, or a
//     `public` entry no other layer reads;
//   - a `?raw` import of a file that is not there (no typecheck sees one);
//   - a fork-owned layer the table does not name, or a table entry with no layer;
//   - an app-root file outside server/registries/ and server/db/schema.ts that
//     imports a layer above core (other than its shared/ types), or whose server
//     or shared code auto-imports one: the app composes through those files.
//     Its pages and layout may use any layer's app/utils and components.
//
// Tests and scripts are exempt, as in layers:check, except from the `?raw`
// check. Vendored layers are checked by layers:check. A layer's root files
// (its nuxt.config.ts) are read for explicit imports only.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import ts from 'typescript'
import { compileTemplate, parse as parseSfc } from 'vue/compiler-sfc'

import { DOMAIN_LAYERS } from '../domains.config'
import {
  appRootProblem,
  componentFindings,
  componentName,
  declaredExports,
  duplicateNames,
  componentRefs,
  fileFindings,
  fileTargets,
  layerPath,
  rawFindings,
  tableProblems,
  templateNames,
  unusedPublic,
  unusedUses,
  type Definition,
  type Finding,
  type LayerTable,
} from './lib/domains'
import { readLock } from './lib/layers'
import { walk } from './lib/walk'

const ROOT = resolve(import.meta.dir, '..')
const rel = (file: string) => relative(ROOT, file)
const table: LayerTable = DOMAIN_LAYERS

const layersDir = join(ROOT, 'layers')
const allLayers = existsSync(layersDir)
  ? readdirSync(layersDir).filter((name) => statSync(join(layersDir, name)).isDirectory())
  : []
const vendored = new Set(Object.keys(readLock().layers))
const forkLayers = allLayers.filter((name) => !vendored.has(name))

const problems: string[] = tableProblems(table, forkLayers)

// ── Auto-imported names ──────────────────────────────────────────────────────
const ts_ = { extensions: ['.ts'], missingOk: true } as const
const owners = ['', ...allLayers.map((name) => `layers/${name}/`)]
const defsOf = (sub: string): Definition[] =>
  owners.flatMap((prefix) =>
    walk(join(ROOT, prefix, sub), ts_)
      .filter((file) => !file.endsWith('.d.ts'))
      .flatMap((file) =>
        declaredExports(readFileSync(file, 'utf8')).map((name) => ({ name, file: rel(file) })),
      ),
  )
const serverDefs = defsOf('server/utils')
const sharedDefs = [...defsOf('shared/utils'), ...defsOf('shared/types')]
const appDefs = [...defsOf('app/utils'), ...defsOf('app/composables')]

const clashes = new Set<string>()
for (const defs of [
  [...serverDefs, ...sharedDefs],
  [...appDefs, ...sharedDefs],
]) {
  for (const { name, files } of duplicateNames(defs))
    clashes.add(`${name} is auto-imported from more than one owner: ${files.join(', ')}`)
}
problems.push(...clashes)

// ── Auto-registered components ───────────────────────────────────────────────
const componentDefs: Definition[] = owners.flatMap((prefix) => {
  const dir = join(ROOT, prefix, 'app/components')
  return walk(dir, { extensions: ['.vue'], missingOk: true }).map((file) => ({
    name: componentName(relative(dir, file)),
    file: rel(file),
  }))
})
for (const { name, files } of duplicateNames(componentDefs)) {
  problems.push(`component ${name} is registered by more than one owner: ${files.join(', ')}`)
}

const mapOf = (defs: readonly Definition[]) => {
  const map = new Map<string, string>()
  for (const def of defs) if (!map.has(def.name)) map.set(def.name, def.file)
  return map
}
const sharedNames = mapOf(sharedDefs)
const components = mapOf(componentDefs)
const serverNames = mapOf([...serverDefs, ...sharedDefs])
const appNames = mapOf([...appDefs, ...sharedDefs])

// ── Free identifiers ─────────────────────────────────────────────────────────
// Every identifier a file uses as a value or type but declares nowhere in it.
// Declarations are collected file-wide, not per scope: a local that shadows an
// auto-import anywhere in the file hides that name, which can miss a use but
// never invents one.
type Free = { name: string; line: number }[]

function freeIdentifiers(file: string, source: string): Free {
  const { declared, refs } = identifiers(file, source, 0)
  return refs.filter((r) => !declared.has(r.name))
}

/** A .vue file's free identifiers: its scripts', and the names its template reads that they don't declare. */
function vueFreeIdentifiers(file: string, source: string): Free {
  const { descriptor, errors } = parseSfc(source, { filename: file })
  if (errors.length > 0) problems.push(`${file}  does not parse as a Vue file: ${errors[0]}`)
  const declared = new Set<string>()
  const refs: Free = []
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue
    const found = identifiers(file, block.content, block.loc.start.line - 1)
    for (const name of found.declared) declared.add(name)
    refs.push(...found.refs)
  }
  const template = descriptor.template
  if (template) {
    const lang = descriptor.scriptSetup?.lang ?? descriptor.script?.lang
    const compiled = compileTemplate({
      source: template.content,
      filename: file,
      id: file,
      compilerOptions: {
        prefixIdentifiers: true,
        expressionPlugins: lang === 'ts' ? ['typescript'] : [],
      },
    })
    if (compiled.errors.length > 0)
      problems.push(`${file}  template does not compile: ${compiled.errors[0]}`)
    for (const name of templateNames(compiled.code)) {
      const at = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).exec(template.content)
      const line =
        template.loc.start.line -
        1 +
        (at ? template.content.slice(0, at.index).split('\n').length : 1)
      refs.push({ name, line })
    }
  }
  return refs.filter((r) => !declared.has(r.name))
}

function identifiers(
  file: string,
  source: string,
  lineOffset: number,
): { declared: Set<string>; refs: Free } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const declared = new Set<string>()
  const refs: { name: string; pos: number }[] = []
  const bind = (name: ts.BindingName | ts.Identifier | undefined) => {
    if (!name) return
    if (ts.isIdentifier(name)) declared.add(name.text)
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bind(el.name)
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isBindingElement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isTypeParameterDeclaration(node) ||
      ts.isImportSpecifier(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportClause(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isModuleDeclaration(node)
    ) {
      const name = (node as { name?: ts.BindingName | ts.Identifier }).name
      if (
        name &&
        (ts.isIdentifier(name) || ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
      ) {
        bind(name)
      }
    }
    if (ts.isIdentifier(node) && isReference(node))
      refs.push({ name: node.text, pos: node.getStart(sf) })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return {
    declared,
    refs: refs.map((r) => ({
      name: r.name,
      line: lineOffset + sf.getLineAndCharacterOfPosition(r.pos).line + 1,
    })),
  }
}

/** Whether an identifier names something, rather than being a property, a key or a declaration. */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false
  if (ts.isQualifiedName(p) && p.right === id) return false
  if (
    (ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) &&
    p.name === id
  ) {
    return false
  }
  if (
    (ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessor(p) ||
      ts.isSetAccessor(p)) &&
    p.name === id
  ) {
    return false
  }
  if (ts.isEnumMember(p) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p))
    return false
  if (ts.isBindingElement(p) && p.propertyName === id) return false
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === id) return false
  if (ts.isExportSpecifier(p)) return true
  if (ts.isImportTypeNode(p) || ts.isMetaProperty(p)) return false
  return true
}

// ── Files ────────────────────────────────────────────────────────────────────
const resolveTarget = (target: string): string | null => {
  for (const candidate of [target, `${target}.ts`, `${target}.vue`, `${target}/index.ts`]) {
    const abs = join(ROOT, candidate)
    if (existsSync(abs) && statSync(abs).isFile()) return candidate
  }
  return null
}

const findings: Finding[] = []
const used = new Map<string, Set<string>>(forkLayers.map((layer) => [layer, new Set<string>()]))
const reachedAcross = new Set<string>()
let scanned = 0

/** Judge one non-test layer file and record which layers it reaches. */
function scan(abs: string, free: Free, names: ReadonlyMap<string, string>) {
  const file = rel(abs)
  const source = readFileSync(abs, 'utf8')
  const own = layerPath(file)!.layer
  scanned += 1
  findings.push(...fileFindings(table, file, source, resolveTarget, free, names))
  const reached = fileTargets(file, source, resolveTarget, free, names)
  if (abs.endsWith('.vue')) {
    findings.push(...componentFindings(table, file, source, components))
    for (const { name } of componentRefs(source)) {
      const target = components.get(name)
      if (target) reached.push(target)
    }
  }
  for (const target of reached) {
    const layer = layerPath(target)?.layer
    if (layer && layer !== own && table[layer]) {
      used.get(own)!.add(layer)
      reachedAcross.add(target)
    }
  }
}

for (const layer of forkLayers) {
  for (const sub of ['server', 'shared']) {
    for (const abs of walk(join(layersDir, layer, sub), ts_)) {
      if (abs.endsWith('.d.ts')) continue
      const source = readFileSync(abs, 'utf8')
      scan(abs, freeIdentifiers(rel(abs), source), sub === 'shared' ? sharedNames : serverNames)
    }
  }
  for (const abs of walk(join(layersDir, layer, 'app'), {
    extensions: ['.ts', '.vue'],
    missingOk: true,
  })) {
    if (abs.endsWith('.d.ts')) continue
    const source = readFileSync(abs, 'utf8')
    const free = abs.endsWith('.vue')
      ? vueFreeIdentifiers(rel(abs), source)
      : freeIdentifiers(rel(abs), source)
    scan(abs, free, appNames)
  }
  // Its root files (nuxt.config.ts): explicit imports only.
  for (const name of readdirSync(join(layersDir, layer)).filter((n) => n.endsWith('.ts')))
    scan(join(layersDir, layer, name), [], new Map())
}
problems.push(...unusedUses(table, used), ...unusedPublic(table, reachedAcross))

// ── The app root ─────────────────────────────────────────────────────────────
for (const sub of ['app', 'server', 'shared']) {
  for (const abs of walk(join(ROOT, sub), { extensions: ['.ts', '.vue'], missingOk: true })) {
    if (abs.endsWith('.d.ts')) continue
    const file = rel(abs)
    const source = readFileSync(abs, 'utf8')
    const free = sub === 'app' ? [] : freeIdentifiers(file, source)
    const names = sub === 'server' ? serverNames : sharedNames
    scanned += 1
    findings.push(...fileFindings(table, file, source, resolveTarget, free, names, appRootProblem))
  }
}

// ── ?raw imports, everywhere ─────────────────────────────────────────────────
for (const dir of [
  ...forkLayers.map((layer) => join(layersDir, layer)),
  ...['app', 'server', 'shared', 'test', 'scripts'].map((d) => join(ROOT, d)),
]) {
  for (const abs of walk(dir, { extensions: ['.ts', '.vue'], missingOk: true })) {
    findings.push(...rawFindings(rel(abs), readFileSync(abs, 'utf8'), resolveTarget))
  }
}

for (const f of findings) problems.push(`${f.file}:${f.line}  ${f.message}`)

if (problems.length === 0) {
  console.info(
    `domains:check — ${forkLayers.length} layer(s), ${scanned} file(s), no import against the domain table`,
  )
  process.exit(0)
}

console.error(`\ndomains:check failed — ${problems.length} problem(s)\n`)
for (const problem of problems) console.error(`  ${problem}`)
console.error(
  '\nA layer imports only the layers domains.config.ts lets it use. Core names no domain: a list of\n' +
    'every domain belongs at the app root, in server/registries/. Rename a clashing util, or move it\n' +
    'to the one layer that owns it.\n',
)
process.exit(1)
