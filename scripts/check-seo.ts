// SEO/AEO gate — run with `bun run seo:check`, wired into `bun run ci`.
//
// Same reasoning as scripts/check-design-tokens.ts: the SEO layer is only a
// contract if something enforces it. Nothing about a missing canonical tag or
// an unlisted page *fails* — the app builds, the page renders, and you find out
// months later from a traffic graph. That delay is exactly why it needs a gate
// and not a convention.
//
// Rules, all of them things this template has wired and can therefore expect:
//
//   1. Every page calls useSeo() exactly once. It is the only thing that emits
//      a canonical tag, Open Graph, and JSON-LD.
//   2. No page calls useSeoMeta()/useHead() to set SEO tags directly, which
//      would bypass all of the above while looking correct.
//   3. Indexable pages declare `definePageMeta({ publicPage: … })`, so they
//      reach sitemap.xml and llms.txt. noindex pages must not.
//   4. Descriptions are present everywhere, and a sensible length on the pages
//      where one is actually shown — a description Google truncates or rewrites
//      is a description you didn't write. noindex pages are exempt from the
//      length rules: nothing renders their snippet, so a rule there would be
//      busywork with a build failure attached.
//   5. Exactly one <h1> per page. Cheap to check, and the single most common
//      real regression in a component-composed page.
//
// Escape hatch: `seo-check-ignore` in a comment on the same line or the line
// above, matching the design-token gate's convention.
//
// The string-reading half of rule 4 lives in scripts/lib/seo-source.ts, so it
// can be driven by ordinary vitest cases (test/seo-source.test.ts) instead of
// by fixtures embedded in a build script. What is left here is the walk, the
// rules, and the report.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { DESCRIPTION_MAX, DESCRIPTION_MIN } from '../shared/utils/seo-bounds'
import { seoDescription, useSeoArgument } from './lib/seo-source'

const ROOT = resolve(import.meta.dir, '..')
const PAGES_DIR = join(ROOT, 'app', 'pages')

interface Problem {
  file: string
  rule: string
  detail: string
  remedy: string
}

function walk(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...walk(full))
    else if (entry.endsWith('.vue')) found.push(full)
  }
  return found
}

/** Strip comments so an example in a doc block can't trip a rule. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function ignored(source: string, needle: string): boolean {
  const lines = source.split('\n')
  return lines.some((line, index) => {
    if (!line.includes(needle)) return false
    const previous = lines[index - 1] ?? ''
    return line.includes('seo-check-ignore') || previous.includes('seo-check-ignore')
  })
}

const problems: Problem[] = []

for (const file of walk(PAGES_DIR)) {
  const relativePath = relative(ROOT, file)
  const raw = readFileSync(file, 'utf8')
  const source = stripComments(raw)

  // ── 1. exactly one useSeo() ────────────────────────────────────────────────
  const seoCalls = source.match(/\buseSeo\s*\(/g)?.length ?? 0
  if (seoCalls === 0) {
    problems.push({
      file: relativePath,
      rule: 'missing useSeo()',
      detail: 'page emits no title, description, canonical, or structured data',
      remedy: 'call useSeo({ title, description }) — add noindex: true if it is private',
    })
    continue
  }
  if (seoCalls > 1) {
    problems.push({
      file: relativePath,
      rule: 'duplicate useSeo()',
      detail: `called ${seoCalls} times`,
      remedy: 'call it once — the last call silently wins for some tags and merges for others',
    })
  }

  // ── 2. nothing bypasses it ─────────────────────────────────────────────────
  if (/\buseSeoMeta\s*\(/.test(source) && !ignored(raw, 'useSeoMeta')) {
    problems.push({
      file: relativePath,
      rule: 'useSeoMeta() bypass',
      detail: 'sets meta tags without a canonical tag or JSON-LD',
      remedy: 'move it into useSeo() — see app/composables/useSeo.ts',
    })
  }
  if (/\buseHead\s*\(\s*\{[\s\S]{0,400}?\b(?:title|meta|link)\s*:/.test(source)) {
    if (!ignored(raw, 'useHead')) {
      problems.push({
        file: relativePath,
        rule: 'useHead() bypass',
        detail: 'sets title/meta/link outside useSeo()',
        remedy: 'move it into useSeo(), or add `seo-check-ignore` if it is genuinely unrelated',
      })
    }
  }

  // ── 3. indexable ⇔ declared public ─────────────────────────────────────────
  const noindex = /\bnoindex\s*:\s*true\b/.test(source)
  const declaresPublic = /\bpublicPage\s*:\s*\{/.test(source)

  if (!noindex && !declaresPublic) {
    problems.push({
      file: relativePath,
      rule: 'indexable page not declared public',
      detail: 'absent from sitemap.xml and llms.txt',
      remedy:
        'add definePageMeta({ publicPage: { changefreq, priority, title, summary } }), or noindex: true',
    })
  }
  if (noindex && declaresPublic) {
    problems.push({
      file: relativePath,
      rule: 'noindex page declared public',
      detail: 'listed in sitemap.xml while telling crawlers not to index it',
      remedy: 'drop the publicPage meta, or drop noindex — the two contradict each other',
    })
  }

  // ── 4. description quality ─────────────────────────────────────────────────
  //
  // Read out of the useSeo() argument, bounded by the call's own parentheses —
  // never out of the whole file. See scripts/lib/seo-source.ts for why that
  // distinction is the difference between this rule working and this rule
  // appearing to work.
  //
  // Two separate claims: a description reached useSeo() at all, and — when the
  // gate can see its text — that text is a length a search result will print
  // rather than truncate. A description computed at runtime satisfies the first
  // and is exempt from the second, which is the honest limit of a source scan.
  const argument = useSeoArgument(source)
  if (argument.kind === 'unreadable') {
    // Fail closed. The gate cannot see what this page publishes, and reporting
    // nothing would be indistinguishable from reporting that it is fine.
    problems.push({
      file: relativePath,
      rule: 'unreadable useSeo() argument',
      detail: argument.detail,
      remedy:
        'pass an object literal, or a local `const x = { … }` — the gate reads source, ' +
        'so it cannot follow an import or a function call',
    })
  }

  const description =
    argument.kind === 'object'
      ? seoDescription(argument.text, source)
      : { present: false, literal: null }

  // An unreadable argument has already been reported; do not also claim the
  // description is missing, which would be a guess.
  if (!description.present && argument.kind === 'object') {
    problems.push({
      file: relativePath,
      rule: 'missing description',
      detail: 'no description passed to useSeo()',
      remedy: 'write one sentence describing what is on this page',
    })
  } else if (description.literal && !noindex) {
    const { quote, text } = description.literal
    const interpolated = quote === '`' && text.includes('${')
    // Interpolated values expand at runtime, so only flag a too-short literal
    // when there is nothing to expand.
    if (!interpolated && text.length < DESCRIPTION_MIN) {
      problems.push({
        file: relativePath,
        rule: 'description too short',
        detail: `${text.length} chars, minimum ${DESCRIPTION_MIN}`,
        remedy: 'search results and answer engines both quote this — make it a real sentence',
      })
    }
    if (text.length > DESCRIPTION_MAX) {
      problems.push({
        file: relativePath,
        rule: 'description too long',
        detail: `${text.length} chars, maximum ${DESCRIPTION_MAX}`,
        remedy: `Google truncates near ${DESCRIPTION_MAX} — say it shorter or it gets said for you`,
      })
    }
  }

  // ── 5. exactly one h1 ──────────────────────────────────────────────────────
  const template = raw.split('<template>').slice(1).join('<template>')
  const h1Count = template.match(/<h1[\s>]/g)?.length ?? 0
  if (h1Count > 1) {
    problems.push({
      file: relativePath,
      rule: 'multiple <h1>',
      detail: `${h1Count} found`,
      remedy: 'one h1 per page — demote the rest to h2',
    })
  }
}

if (problems.length === 0) {
  console.info('seo:check — no problems')
  process.exit(0)
}

console.error(`\nseo:check failed — ${problems.length} problem(s)\n`)
for (const { file, rule, detail, remedy } of problems) {
  console.error(`  ${file}  ${rule}`)
  console.error(`    ${detail}`)
  console.error(`    → ${remedy}\n`)
}
console.error('app/composables/useSeo.ts is the contract. Add `seo-check-ignore`')
console.error('on the line above if this is a genuine exception.\n')
process.exit(1)
