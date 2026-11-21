// The rules half of `bun run domains:check` (scripts/check-domains.ts).
//
// Strings in, answers out, so test/domains.test.ts can drive every rule without
// a filesystem or the TypeScript parser (which cannot load in workerd). The gate
// walks the layers, parses each file for the identifiers it leaves unresolved,
// and hands both to the functions here.

import { blankNonCode } from './method-bodies'

/** One fork-owned layer: which layers it may import, and what it lets others import. */
export interface LayerRule {
  /** Layers this one builds on. Allowed imports are these and everything they build on. */
  uses: readonly string[]
  /**
   * Paths inside the layer (a file, or a directory ending in `/`) another layer
   * may import or auto-import from, beside `shared/`, which is always open.
   * Omitted: the whole layer is open, as core is to everything above it.
   */
  public?: readonly string[]
}

export type LayerTable = Readonly<Record<string, LayerRule>>

/** Every layer `layer` may reach: its `uses`, and theirs, transitively. */
export function reachable(table: LayerTable, layer: string): Set<string> {
  const out = new Set<string>()
  const visit = (name: string) => {
    for (const dep of table[name]?.uses ?? []) {
      if (out.has(dep)) continue
      out.add(dep)
      visit(dep)
    }
  }
  visit(layer)
  return out
}

/** Problems with the table itself: a layer on disk it does not name, a name with no layer, a cycle. */
export function tableProblems(table: LayerTable, layersOnDisk: readonly string[]): string[] {
  const problems: string[] = []
  for (const name of layersOnDisk) {
    if (!table[name]) problems.push(`layers/${name} is not in the domain table`)
  }
  for (const [name, rule] of Object.entries(table)) {
    if (!layersOnDisk.includes(name))
      problems.push(`the domain table names ${name}, which is not a layer`)
    for (const dep of rule.uses) {
      if (!table[dep]) problems.push(`${name} uses ${dep}, which the domain table does not define`)
    }
    if (reachable(table, name).has(name))
      problems.push(`${name} depends on itself through its uses`)
  }
  return problems
}

/** `layers/<name>/<rest>` split into its layer and the path inside it; null outside layers/. */
export function layerPath(file: string): { layer: string; rest: string } | null {
  const match = /^layers\/([^/]+)\/(.+)$/.exec(file)
  return match ? { layer: match[1]!, rest: match[2]! } : null
}

const isTest = (rest: string) => rest.startsWith('test/')

/**
 * Why `from` may not import `to` (both repo-relative paths), or null when it may.
 * Only an edge between two layers of the table is judged; the app root, vendored
 * layers and packages are open to every layer. Tests are exempt: a test may drive
 * two layers together to pin how they fit.
 */
export function edgeProblem(table: LayerTable, from: string, to: string): string | null {
  const a = layerPath(from)
  const b = layerPath(to)
  if (!a || !b || a.layer === b.layer || isTest(a.rest)) return null
  if (!table[a.layer] || !table[b.layer]) return null
  if (!reachable(table, a.layer).has(b.layer)) {
    return `${a.layer} may not import ${b.layer} (domain table: ${a.layer} uses ${table[a.layer]!.uses.join(', ') || 'nothing'})`
  }
  const open = table[b.layer]!.public
  if (!open || b.rest.startsWith('shared/')) return null
  const ok = open.some((p) => (p.endsWith('/') ? b.rest.startsWith(p) : b.rest === p))
  return ok ? null : `${b.rest} is not on ${b.layer}'s public list`
}

// ── Import specifiers ───────────────────────────────────────────────────────

const SPECIFIER =
  /\b(?:from\s*|import\s*\(\s*|import\s+|vi\.(?:mock|doMock|importActual)\s*\(\s*)(['"])([^'"\n]+)\1/g

export interface Specifier {
  line: number
  spec: string
}

/** Every module a file names: static and dynamic imports, re-exports, vi.mock. */
export function importSpecifiers(source: string): Specifier[] {
  const code = blankComments(source)
  const out: Specifier[] = []
  for (const match of code.matchAll(SPECIFIER)) {
    out.push({ line: code.slice(0, match.index).split('\n').length, spec: match[2]! })
  }
  return out
}

/** Comments blanked (newlines kept), strings left whole: a specifier is a string. */
function blankComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i]!
    const next = source[i + 1]
    if (ch === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2)
      const stop = close === -1 ? source.length : next === '/' ? close : close + 2
      out += source.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1
      out += source.slice(i, j + 1)
      i = j + 1
    } else {
      out += ch
      i += 1
    }
  }
  return out
}

/**
 * The repo-relative path a specifier points at, before extension resolution:
 * relative paths against the importing file, `#layers/<name>/…`, `~~/…` and `@@/…`.
 * Null for a package, a Nuxt alias into the app root (`#server`, `#shared`), or
 * anything else that cannot name a layer file.
 */
export function specifierTarget(file: string, spec: string): string | null {
  const bare = spec.replace(/^raw:/, '').replace(/\?.*$/, '')
  if (bare.startsWith('#layers/')) return `layers/${bare.slice('#layers/'.length)}`
  if (bare.startsWith('~~/') || bare.startsWith('@@/')) return bare.slice(3)
  if (!bare.startsWith('./') && !bare.startsWith('../')) return null
  const parts = file.split('/').slice(0, -1)
  for (const seg of bare.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

// ── Auto-imported names ─────────────────────────────────────────────────────

/**
 * Names a module declares and exports. A re-export (`export … from`) names
 * another module's binding, so it is not a second definition and is left out.
 */
export function declaredExports(source: string): string[] {
  const code = blankNonCode(source)
  const names = new Set<string>()
  const DECL =
    /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g
  for (const match of code.matchAll(DECL)) names.add(match[1]!)
  for (const match of code.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/g)) {
    for (const part of match[1]!.split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()!
        .replace(/^type\s+/, '')
        .trim()
      if (name && name !== 'default') names.add(name)
    }
  }
  return [...names].sort()
}

export interface Definition {
  name: string
  file: string
}

/** The owner of a file: its layer's name, or `app` for the app root. */
export function ownerOf(file: string): string {
  return layerPath(file)?.layer ?? 'app'
}

/** Names defined in auto-imported files of two or more owners: the later layer silently wins. */
export function duplicateNames(defs: readonly Definition[]): { name: string; files: string[] }[] {
  const byName = new Map<string, Definition[]>()
  for (const def of defs) byName.set(def.name, [...(byName.get(def.name) ?? []), def])
  return [...byName]
    .filter(([, list]) => new Set(list.map((d) => ownerOf(d.file))).size > 1)
    .map(([name, list]) => ({ name, files: list.map((d) => d.file).sort() }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface Finding {
  file: string
  line: number
  message: string
}

/**
 * Edges a file's explicit imports and its auto-imported names make. `resolve`
 * turns a target path into the real file (adding the extension), or null when
 * it is not one; `free` is each identifier the file uses but never declares,
 * with its line; `autoImports` maps every auto-imported name to its file.
 */
export function fileFindings(
  table: LayerTable,
  file: string,
  source: string,
  resolve: (target: string) => string | null,
  free: readonly { name: string; line: number }[],
  autoImports: ReadonlyMap<string, string>,
): Finding[] {
  const findings: Finding[] = []
  for (const { line, spec } of importSpecifiers(source)) {
    const target = specifierTarget(file, spec)
    const real = target === null ? null : (resolve(target) ?? target)
    if (real === null) continue
    const problem = edgeProblem(table, file, real)
    if (problem) findings.push({ file, line, message: `imports ${spec}: ${problem}` })
  }
  const seen = new Set<string>()
  for (const { name, line } of free) {
    const defined = autoImports.get(name)
    if (!defined || seen.has(name)) continue
    const problem = edgeProblem(table, file, defined)
    if (!problem) continue
    seen.add(name)
    findings.push({
      file,
      line,
      message: `uses ${name} (auto-imported from ${defined}): ${problem}`,
    })
  }
  return findings
}

// ── Auto-registered components ──────────────────────────────────────────────

const pascal = (segment: string) =>
  segment
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('')

/**
 * The name Nuxt registers a component under, from its path below a
 * `components/` directory: its folders as a prefix, then its file name, with a
 * file name that already starts with the prefix kept whole and `index` dropped.
 */
export function componentName(path: string): string {
  const segments = path
    .replace(/\.vue$/, '')
    .split('/')
    .map(pascal)
  const file = segments.pop()!
  const prefix = segments.join('')
  if (file === 'Index') return prefix
  return file.startsWith(prefix) ? file : prefix + file
}

/**
 * Every component name a `.vue` file's template tags name, PascalCase, with any
 * `Lazy` prefix dropped. Only the template is read, so a type argument in the
 * script (`ref<Foo>`) is never taken for a tag.
 */
export function componentRefs(source: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = []
  const start = source.indexOf('<template')
  if (start === -1) return out
  const end = source.lastIndexOf('</template>')
  const template = source.slice(0, end === -1 ? source.length : end)
  const tags = /<([A-Za-z][\w-]*)/g
  tags.lastIndex = start
  for (const match of template.matchAll(tags)) {
    const tag = match[1]!
    const name = /^[A-Z]/.test(tag) ? tag : tag.includes('-') ? pascal(tag) : null
    if (!name) continue
    out.push({
      name: name.replace(/^Lazy(?=[A-Z])/, ''),
      line: source.slice(0, match.index).split('\n').length,
    })
  }
  return out
}

/**
 * Components a `.vue` file names that live in a layer it may not use. `defined`
 * maps each auto-registered component name to its file. Only `uses` is judged:
 * a layer's components are open to every layer above it, as Nuxt registers them
 * app-wide with no import to put on a public list.
 */
export function componentFindings(
  table: LayerTable,
  file: string,
  source: string,
  defined: ReadonlyMap<string, string>,
): Finding[] {
  const a = layerPath(file)
  if (!a || isTest(a.rest) || !table[a.layer]) return []
  const findings: Finding[] = []
  const seen = new Set<string>()
  for (const { name, line } of componentRefs(source)) {
    const target = defined.get(name)
    const b = target ? layerPath(target) : null
    if (!target || !b || b.layer === a.layer || !table[b.layer] || seen.has(name)) continue
    if (reachable(table, a.layer).has(b.layer)) continue
    seen.add(name)
    findings.push({
      file,
      line,
      message: `uses <${name}> (from ${target}): ${a.layer} may not use ${b.layer} (domain table: ${a.layer} uses ${table[a.layer]!.uses.join(', ') || 'nothing'})`,
    })
  }
  return findings
}
