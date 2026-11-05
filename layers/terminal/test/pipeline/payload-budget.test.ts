import { describe, expect, test } from 'vitest'

import manifestJson from '~~/fixtures/manifest.json'
import sourcesYaml from '~~/sources.yaml?raw'

import { parseDerivedSourcesBlock } from '../../server/pipeline/derived'
import { MAX_BODY_BYTES } from '../../server/pipeline/fetch'
import { CAREERS_SOURCES, sourceIdsForScope } from '../../server/pipeline/scopes'
import { includeSources, type FetchSource } from '../../server/pipeline/sources'
import { TRIPWIRE_REFRESH } from '../../server/pipeline/tripwire'
import { RECIPES } from '../../server/theses/recipes/registry'
import { PARQUET_ROW_GROUP_BYTES } from '../../server/utils/terminal-parquet'

// The payload-size gate. Every cron invocation is one Worker isolate with
// 128 MB, and the poll loop holds each payload several times over (wire bytes,
// decoded string, hash input, R2 body, parse tree) while slices of it can
// outlive the source. On 2026-11-04 the 18:00 survey was killed for
// exceededMemory on google-careers' (~20 MB) first tick. Its poll got past
// google-careers and through every later source (/api/status › sources), and
// the isolate died after the poll, so what one invocation had pushed through
// mattered, not just one payload's peak. Both limits come from that tick.
//
// SOURCE_BUDGET, 16 MiB: the largest payloads that have shared the survey
// without incident are ~14 MB (the Anthropic prospectuses, pay-openai); the one
// that broke it was ~20 MB. At roughly six copies at peak, 16 MiB is ~96 MB of
// the 128, leaving ~30 MB for the bundle, D1 and whatever the tick holds. A
// source over it runs alone, in a lane of its own.
//
// LANE_BUDGET, 112 MiB: the 12:00 survey completed carrying ~108 MiB by this
// table; the 18:00 one carried ~128 MiB (google-careers and the newsrooms
// added) and died. The budget sits between the two, nearer the evidence of
// survival. The survey is close to it (~109 MiB): its next large source
// belongs in a lane of its own.
//
// Sizes are what was recorded, not what is live: fixtures/manifest.json's
// raw_bytes (the capture), or `raw_bytes:` on a sources.yaml entry with no
// fixture (measured with `curl -sL --compressed <url> | wc -c`, decompressed,
// because that is what the Worker holds). A source with neither is sized by
// the largest recorded source sharing the longest run of its leading
// dash-separated id segments (npm-openai by npm-claude-code); one with no such
// sibling fails the gate. Upstream growth is invisible here until a fixture is
// recaptured. Out of scope: the hyperscaler filed facts that follow the edgar
// poll (layers/terminal/server/exposure/ingest.ts), bounded in code by
// INSTANCES_PER_RUN rather than by this table; each is still held to
// SOURCE_BUDGET.

const MiB = 1024 * 1024
const SOURCE_BUDGET = 16 * MiB
const LANE_BUDGET = 112 * MiB

/**
 * Derived sources are named by the store, not by a file, so a lane's real
 * count comes from production: every instance per family in /api/status ›
 * sources on 2026-11-04, statics in the same family included. Each one beyond
 * the committed fixtures is sized like its family's largest fixture. Raise a
 * count when a family grows by a large instance (a new prospectus is ~14 MB).
 */
const DERIVED_INSTANCES: Readonly<Record<string, number>> = {
  'edgar-submissions': 8,
  'edgar-companyfacts': 2,
  'xbrl-segment': 4,
  'filing-index': 2,
  'prospectus-revenue': 2,
  'openai-model-md': 36,
  'google-model-md': 29,
  'openai-misalignment-report': 20,
}

interface Lane {
  name: string
  /** Where the lane's sources are listed, for the failure message. */
  where: string
  ids: readonly string[]
}

type Size = { bytes: number; from: string }

/** `raw_bytes:` on any 2-space sources.yaml entry, by id. */
function yamlRawBytes(yaml: string): Map<string, number> {
  const out = new Map<string, number>()
  let id: string | null = null
  for (const line of yaml.split('\n')) {
    const head = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*(#.*)?$/)
    if (head) id = head[1]!
    else if (/^\S/.test(line)) id = null
    const raw = line.match(/^ {4}raw_bytes:\s*(\d+)\b/)
    if (raw && id) out.set(id, Number(raw[1]))
  }
  return out
}

function sizer(recorded: ReadonlyMap<string, Size>): (id: string) => Size | null {
  const segments = (id: string) => id.split('-')
  return (id) => {
    const own = recorded.get(id)
    if (own) return own
    const mine = segments(id)
    let best: { shared: number; size: Size } | null = null
    for (const [other, size] of recorded) {
      const theirs = segments(other)
      let shared = 0
      while (shared < mine.length && mine[shared] === theirs[shared]) shared++
      if (shared === 0) continue
      if (
        !best ||
        shared > best.shared ||
        (shared === best.shared && size.bytes > best.size.bytes)
      ) {
        best = { shared, size: { bytes: size.bytes, from: `sized like ${other}` } }
      }
    }
    return best?.size ?? null
  }
}

const mib = (bytes: number) => `${(bytes / MiB).toFixed(1)} MiB`

const OWN_LANE_FIX =
  'Give it an invocation of its own, as #164 did for google-careers: a scope in ' +
  'layers/terminal/server/pipeline/scopes.ts like CAREERS_SOURCES, a task under ' +
  'layers/terminal/server/tasks/poll/, and one cron string on a minute no other trigger uses, in ' +
  'both SCHEDULED_TASKS (nuxt.config.ts) and [triggers] crons (wrangler.toml). A recipe moves out ' +
  'of RECIPES (layers/terminal/server/theses/recipes/registry.ts) into a task of its own the same way.'

function budgetViolations(lanes: readonly Lane[], sizeOf: (id: string) => Size | null): string[] {
  const out: string[] = []
  for (const lane of lanes) {
    let total = 0
    const sized: { id: string; size: Size }[] = []
    for (const id of new Set(lane.ids)) {
      const size = sizeOf(id)
      if (!size) {
        out.push(
          `${id} (${lane.name} lane) has no recorded size. Commit its fixture with raw_bytes in ` +
            'fixtures/manifest.json, or add `raw_bytes: <n>` to its sources.yaml entry, measured ' +
            'decompressed: curl -sL --compressed <url> | wc -c',
        )
        continue
      }
      total += size.bytes
      sized.push({ id, size })
    }
    for (const { id, size } of sized) {
      if (size.bytes > MAX_BODY_BYTES) {
        out.push(
          `${id} is ${mib(size.bytes)} (${size.from}), over fetch.ts MAX_BODY_BYTES ` +
            `(${mib(MAX_BODY_BYTES)}): the fetcher abandons it on every tick. Take a smaller ` +
            'document or a filtered endpoint.',
        )
      } else if (size.bytes > SOURCE_BUDGET && sized.length > 1) {
        out.push(
          `${id} is ${mib(size.bytes)} (${size.from}), over SOURCE_BUDGET (${mib(SOURCE_BUDGET)}), ` +
            `and shares the ${lane.name} lane (${lane.where}) with ${sized.length - 1} other ` +
            `sources. ${OWN_LANE_FIX}`,
        )
      }
    }
    if (total > LANE_BUDGET) {
      const largest = sized
        .toSorted((a, b) => b.size.bytes - a.size.bytes)
        .slice(0, 5)
        .map(({ id, size }) => `${id} ${mib(size.bytes)}`)
        .join(', ')
      out.push(
        `The ${lane.name} lane (${lane.where}) fetches ${mib(total)} per invocation, over ` +
          `LANE_BUDGET (${mib(LANE_BUDGET)}). Largest: ${largest}. Move the largest out: ` +
          `${OWN_LANE_FIX} Raise LANE_BUDGET only on production evidence that an invocation ` +
          'carrying the larger set completed.',
      )
    }
  }
  return out
}

// ── The lanes production runs ────────────────────────────────────────────────

const recorded = new Map<string, Size>()
for (const [id, bytes] of yamlRawBytes(sourcesYaml)) {
  recorded.set(id, { bytes, from: 'sources.yaml raw_bytes' })
}
for (const f of manifestJson.fixtures) {
  recorded.set(f.source_id, { bytes: f.raw_bytes, from: `fixture ${f.path}` })
}
const sizeOf = sizer(recorded)

const statics = includeSources(sourcesYaml, manifestJson.fixtures)
const staticIds = new Set(statics.map((s) => s.source_id))
const families = parseDerivedSourcesBlock(sourcesYaml).map((t) => t.id)
const familyOf = (id: string) => families.find((f) => id.startsWith(`${f}-`))
const derivedFixtures: FetchSource[] = manifestJson.fixtures
  .filter((f) => !staticIds.has(f.source_id) && familyOf(f.source_id))
  .map((f) => ({ source_id: f.source_id, url: f.source_url, ext: 'raw' }))
const known = [...statics, ...derivedFixtures]

/** Production's instances beyond the committed ones, as placeholder ids the sizer prices by family. */
function productionExtras(): string[] {
  const out: string[] = []
  for (const family of families) {
    const have = known.filter((s) => familyOf(s.source_id) === family).length
    for (let n = have; n < (DERIVED_INSTANCES[family] ?? 0); n++) {
      out.push(`${family}-production-${n + 1}`)
    }
  }
  return out
}

/**
 * The edgar tick at its heaviest: the day after the newest committed
 * registration filing, when every one of them is fresh and unparsed and so
 * rides the half-hourly tick (scopes.ts › REGISTRATION_PREFIXES).
 */
function edgarWorstNow(): Date {
  const filed = derivedFixtures
    .map((s) => s.source_id.match(/-(\d{4}-\d{2}-\d{2})-\d{10}-\d{2}-\d{6}$/)?.[1])
    .filter((d): d is string => !!d)
    .toSorted()
  const newest = filed.at(-1)
  return newest ? new Date(Date.parse(`${newest}T00:00:00Z`) + 86_400_000) : new Date()
}

const SCOPES = 'layers/terminal/server/pipeline/scopes.ts'
const productionLanes: readonly Lane[] = [
  {
    name: 'edgar',
    where: `${SCOPES}, */30`,
    ids: sourceIdsForScope('edgar', known, edgarWorstNow()),
  },
  {
    name: 'survey',
    where: `${SCOPES} + theses/recipes/registry.ts, 0 */6`,
    ids: [
      ...sourceIdsForScope('survey', known),
      ...productionExtras(),
      ...RECIPES.map((r) => r.id),
    ],
  },
  { name: 'careers', where: `${SCOPES}, 17 */6`, ids: sourceIdsForScope('careers', known) },
  {
    name: 'tripwire',
    where: 'layers/terminal/server/pipeline/tripwire.ts, */5',
    ids: TRIPWIRE_REFRESH,
  },
]

describe('payload budget', () => {
  test('every derived family has a production count', () => {
    const missing = families.filter((f) => DERIVED_INSTANCES[f] === undefined)
    expect(
      missing,
      'add each new derived_sources family to DERIVED_INSTANCES with its count in production',
    ).toEqual([])
  })

  test('no lane carries a source or a total its invocation cannot hold', () => {
    expect(budgetViolations(productionLanes, sizeOf)).toEqual([])
  })

  test('the filed facts that follow the edgar poll each fit SOURCE_BUDGET', () => {
    const filedFacts = manifestJson.fixtures.filter((f) => f.source_id.startsWith('filed-facts-'))
    expect(filedFacts.length).toBeGreaterThan(0)
    expect(filedFacts.filter((f) => f.raw_bytes > SOURCE_BUDGET).map((f) => f.source_id)).toEqual(
      [],
    )
  })

  // The configuration that died on 2026-11-04: google-careers inside the survey.
  test('catches google-careers back in the survey', () => {
    const merged = productionLanes
      .filter((l) => l.name !== 'careers')
      .map((l) => (l.name === 'survey' ? { ...l, ids: [...l.ids, ...CAREERS_SOURCES] } : l))
    const found = budgetViolations(merged, sizeOf)
    expect(
      found.some((v) => v.startsWith('google-careers is') && v.includes('SOURCE_BUDGET')),
    ).toBe(true)
    expect(found.some((v) => v.startsWith('The survey lane'))).toBe(true)
  })

  test('a source with no recorded size and no sibling fails with the fix', () => {
    const found = budgetViolations([{ name: 'survey', where: 'x', ids: ['zz-unknown'] }], sizeOf)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('raw_bytes')
  })

  test('a big source alone in its lane passes', () => {
    expect(
      budgetViolations([{ name: 'big', where: 'x', ids: ['google-careers'] }], sizeOf),
    ).toEqual([])
  })

  test('sizes an unrecorded source by its closest sibling', () => {
    expect(sizeOf('npm-openai')?.from).toBe('sized like npm-claude-code')
    expect(sizeOf('limits-openai-gpt-5-6-luna')?.from).toBe('sized like limits-openai-gpt-6-astra')
  })
})

// The bulk build (tasks/bulk/build.ts, hourly at :41) runs in an invocation of
// its own and holds one cut of one table at a time: the gzipped CSV and the
// Parquet file so far, each copied once more when it is finished, plus one
// Parquet row group of decoded rows. The row group is what grows with a
// table's width, so PARQUET_ROW_GROUP_BYTES caps it in characters of cell
// text, whatever the table.
//
// Measured 2026-11-05 on the production feed's full history (every table
// rebuilt from /export/<table>.json?history=full with the build's own
// parquetBuilder): the largest files are snapshots' (61,729 rows), 2.2 MB as
// gzipped CSV and 1.4 MB as Parquet, and the heap grew at most 22 MB while a
// table was written (source_runs). DECODED_FACTOR sizes a group's heap from its
// text: UTF-16 doubles it, and each row's object, boxed values, BigInts and
// Dates add about as much again.
describe('bulk build memory', () => {
  const LARGEST_CSV_GZ = 2_203_529
  const LARGEST_PARQUET = 1_366_838
  const DECODED_FACTOR = 4

  test('one cut of a table ten times today’s largest fits the lane budget', () => {
    const files = 10 * (LARGEST_CSV_GZ + LARGEST_PARQUET) * 2
    const rowGroup = PARQUET_ROW_GROUP_BYTES * DECODED_FACTOR
    expect(rowGroup).toBeLessThanOrEqual(SOURCE_BUDGET)
    expect(files + rowGroup).toBeLessThan(LANE_BUDGET)
  })
})
