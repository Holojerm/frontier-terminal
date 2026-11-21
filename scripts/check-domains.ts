// Domain boundary gate — run with `bun run domains:check`, wired into `bun run ci` and `ci:fast`.
//
// The product code is split into Nuxt layers by business domain, on a shared
// `core` (AGENTS.md › Directory Structure). Nothing in Nuxt stops one layer
// reaching into another: a relative path, `#layers/<name>/…` and `~~/layers/…`
// all resolve, and every layer's server/utils and shared/utils are
// auto-imported into every other with no import line at all. So this fails on:
//
//   - an import, explicit or auto, against the direction in domains.config.ts
//     (core imports no other fork-owned layer), or of a domain file that is not
//     on that domain's public list;
//   - a server/utils or shared/utils export name defined by two owners (the app
//     or a layer): Nuxt keeps one and drops the other without an error;
//   - a component a layer's .vue file names that is registered by a layer it
//     does not use, or a component name two owners register (the later layer wins);
//   - a fork-owned layer the table does not name, or a table entry with no layer.
//
// The app root may import any layer: it is the composition root (server/db/schema.ts,
// server/registries/). Tests are exempt, as in layers:check. Vendored layers are
// checked by layers:check, not here. Only .ts files under server/ and shared/ are
// read for auto-imported names; .vue files are read for the components they name.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import ts from 'typescript'

import { DOMAIN_LAYERS } from '../domains.config'
import {
  componentFindings,
  componentName,
  declaredExports,
  duplicateNames,
  fileFindings,
  tableProblems,
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
const sharedDefs = defsOf('shared/utils')

for (const { name, files } of duplicateNames([...serverDefs, ...sharedDefs])) {
  problems.push(`${name} is auto-imported from more than one owner: ${files.join(', ')}`)
}

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

// ── Free identifiers ─────────────────────────────────────────────────────────
// Every identifier a file uses as a value or type but declares nowhere in it.
// Declarations are collected file-wide, not per scope: a local that shadows an
// auto-import anywhere in the file hides that name, which can miss a use but
// never invents one.
function freeIdentifiers(file: string, source: string): { name: string; line: number }[] {
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
  return refs
    .filter((r) => !declared.has(r.name))
    .map((r) => ({ name: r.name, line: sf.getLineAndCharacterOfPosition(r.pos).line + 1 }))
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
let scanned = 0
for (const layer of forkLayers) {
  for (const sub of ['server', 'shared']) {
    for (const abs of walk(join(layersDir, layer, sub), ts_)) {
      if (abs.endsWith('.d.ts')) continue
      const file = rel(abs)
      const source = readFileSync(abs, 'utf8')
      const names = sub === 'shared' ? sharedNames : serverNames
      scanned += 1
      findings.push(
        ...fileFindings(table, file, source, resolveTarget, freeIdentifiers(file, source), names),
      )
    }
  }
  // Explicit imports only, for the rest of the layer: pages, components, its config.
  const rest = [
    ...walk(join(layersDir, layer, 'app'), { extensions: ['.ts', '.vue'], missingOk: true }),
    ...readdirSync(join(layersDir, layer))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(layersDir, layer, name)),
  ]
  for (const abs of rest) {
    scanned += 1
    const source = readFileSync(abs, 'utf8')
    findings.push(...fileFindings(table, rel(abs), source, resolveTarget, [], new Map()))
    if (abs.endsWith('.vue'))
      findings.push(...componentFindings(table, rel(abs), source, components))
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
