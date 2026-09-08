import { describe, expect, test } from 'vitest'

import {
  ChangeRow,
  contentHash,
  stableStringify as contractsStableStringify,
  type FilingRow,
  type PriceRow,
} from '../../server/pipeline/contracts'
import { diff } from '../../server/pipeline/diff'
import {
  normalizeFilings,
  normalizeJobs,
  normalizePrices,
  stableStringify,
  type JobRow,
} from '../../server/pipeline/normalize'
import { fixtureText, provenanceOf } from './fixtures'

// Normalize + diff golden tests. Done-bar: diff of two entity sets produces
// ChangeRow[] that validate, and a change is reproducible from the two
// snapshots alone.
//
// Entity sets are built here from committed fixtures with minimal inline
// mapping (no parser imports — the lane is tested on its own). Provenance
// (source_url, fetched_at) is read from fixtures/manifest.json, never invented.

// detected_at is an input to diff(), never Date.now(); this constant is the
// test's simulated pipeline-run clock, not a provenance claim.
const DETECTED_AT = '2026-08-25T12:00:00Z'

// ---- jobs: fixtures/hiring/xai-greenhouse.json (42 rows) ------------------
const xaiJobsProv = provenanceOf('xai-greenhouse')
const xaiBoard = JSON.parse(fixtureText('fixtures/hiring/xai-greenhouse.json')) as {
  jobs: {
    id: number
    title: string
    location: { name: string } | null
    updated_at: string | null
    first_published: string | null
    company_name: string | null
  }[]
}
const jobRows: JobRow[] = xaiBoard.jobs.map((j) => ({
  provider: 'xai' as const,
  job_id: String(j.id),
  title: j.title,
  department: null, // greenhouse jobs endpoint carries no department field (manifest note)
  team: null,
  location: j.location?.name ?? null,
  employment_type: null,
  published_at: j.first_published ?? null,
  updated_at: j.updated_at ?? null,
  company_name: j.company_name ?? null, // "SpaceXAI" — entity-blended board caveat travels with the data
  ...xaiJobsProv,
}))

// ---- filings: fixtures/sec/edgar-submissions-spcx.json (first 10) ---------
const secProv = provenanceOf('edgar-submissions-spcx')
const spcx = JSON.parse(fixtureText('fixtures/sec/edgar-submissions-spcx.json')) as {
  cik: string
  name: string
  filings: { recent: { accessionNumber: string[]; form: string[]; filingDate: string[] } }
}
const recent = spcx.filings.recent
const filingRows: FilingRow[] = recent.accessionNumber.slice(0, 10).map((acc, i) => ({
  accession_no: acc,
  form: recent.form[i]!,
  file_date: recent.filingDate[i]!,
  ciks: [spcx.cik],
  display_names: [spcx.name],
  whitelist_cik: spcx.cik, // SPCX is on the sources.yaml CIK whitelist
  ...secProv,
}))

// ---- prices: hand-transcribed from fixtures/pricing/xai-models.md ---------
// "Text API Pricing" grok-4.6 long-context pair, values as printed. The
// >= 200k row takes tier "long_context" per the PriceRow.tier contract note.
const xaiMdProv = provenanceOf('xai-models-md')
const priceRows: PriceRow[] = [
  {
    provider: 'xai',
    model_slug: 'grok-4.6',
    tier: null,
    context_window: '500k',
    input_per_mtok: 2.0,
    cached_input_per_mtok: 0.5,
    output_per_mtok: 6.0,
    currency: 'USD',
    effective_from: null,
    effective_until: null,
    notes: '< 200k prompt tokens',
    ...xaiMdProv,
  },
  {
    provider: 'xai',
    model_slug: 'grok-4.6',
    tier: 'long_context',
    context_window: '500k',
    input_per_mtok: 4.0,
    cached_input_per_mtok: 1.0,
    output_per_mtok: 12.0,
    currency: 'USD',
    effective_from: null,
    effective_until: null,
    notes: '>= 200k prompt tokens',
    ...xaiMdProv,
  },
]

const SNAP_BEFORE = `xai-greenhouse:${xaiJobsProv.fetched_at}`
const SNAP_AFTER = 'xai-greenhouse:sim-after' // simulated later poll of the same board

// Fixture-derived before/after pair: one job vanishes from the board, one
// appears, one relocates. All three ids exist in the committed fixture.
const REMOVED_ID = '4741579007' // Data Center Operations Technician
const ADDED_ID = '5090171007' // AI Tutor - Arabic
const MODIFIED_ID = '5090189007' // AI Tutor - Danish
const MODIFIED_LOCATION = 'Palo Alto, California' // synthetic after-state for the simulation

function buildBeforeAfter() {
  const beforeJobs = jobRows.filter((j) => j.job_id !== ADDED_ID)
  const afterJobs = jobRows
    .filter((j) => j.job_id !== REMOVED_ID)
    .map((j) => (j.job_id === MODIFIED_ID ? { ...j, location: MODIFIED_LOCATION } : j))
  return {
    before: normalizeJobs(beforeJobs, SNAP_BEFORE),
    after: normalizeJobs(afterJobs, SNAP_AFTER),
  }
}

describe('normalize-diff lane', () => {
  test('same snapshot diffed against itself yields zero changes', () => {
    const entities = [
      ...normalizeJobs(jobRows, SNAP_BEFORE),
      ...normalizeFilings(filingRows, `edgar-submissions-spcx:${secProv.fetched_at}`),
      ...normalizePrices(priceRows, `xai-models-md:${xaiMdProv.fetched_at}`),
    ]
    expect(entities).toHaveLength(54) // 42 jobs + 10 filings + 2 price SKUs

    const keys = entities.map((e) => e.entity_key)
    expect(keys).toContain('job:xai:4741579007')
    expect(keys).toContain('filing:0001426012-26-000004')
    expect(keys).toContain('model:xai:grok-4.6')
    expect(keys).toContain('model:xai:grok-4.6:long_context')

    expect(diff(entities, entities, DETECTED_AT)).toEqual([])
  })

  test('normalize refuses the same entity_key with different content (a tier-disambiguation bug), collapses identical repeats', () => {
    const [standard, longContext] = priceRows as [PriceRow, PriceRow]
    // Byte-identical repeat: harmless, collapses to one row.
    expect(normalizePrices([standard, standard], 'snap')).toHaveLength(1)
    // Same key, different content: a parser bug, never a silent winner.
    expect(() =>
      normalizePrices([standard, { ...longContext, tier: standard.tier }], 'snap'),
    ).toThrow(/conflicting rows for entity_key model:xai:grok-4.6/)
  })

  test('added/removed/modified detected across two fixture-derived entity sets, keyed on entity_key', () => {
    const { before, after } = buildBeforeAfter()
    expect(before).toHaveLength(41)
    expect(after).toHaveLength(41)

    const changes = diff(before, after, DETECTED_AT)
    expect(changes.map((c) => [c.entity_key, c.change_type])).toEqual([
      [`job:xai:${REMOVED_ID}`, 'removed'],
      [`job:xai:${ADDED_ID}`, 'added'],
      [`job:xai:${MODIFIED_ID}`, 'modified'],
    ])

    const removed = changes[0]!
    expect(removed.before_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(removed.after_hash).toBeNull()
    expect(removed.after_json).toBeNull()
    // Removed rows keep the before-side provenance — the last observation.
    expect(removed.source_url).toBe('https://boards-api.greenhouse.io/v1/boards/xai/jobs')
    expect(removed.fetched_at).toBe('2026-08-25T23:08:17Z')

    const added = changes[1]!
    expect(added.before_hash).toBeNull()
    expect(added.before_json).toBeNull()
    expect(added.after_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(added.after_json!).title).toBe('AI Tutor - Arabic')

    // Every ChangeRow revalidates against the contract (superRefine incl.).
    for (const c of changes) expect(ChangeRow.safeParse(c).success).toBe(true)
  })

  test('modified rows carry both content hashes and both payloads (before_json/after_json)', () => {
    const { before, after } = buildBeforeAfter()
    const modified = diff(before, after, DETECTED_AT).find((c) => c.change_type === 'modified')!

    expect(modified.entity_key).toBe(`job:xai:${MODIFIED_ID}`)
    expect(modified.before_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(modified.after_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(modified.before_hash).not.toBe(modified.after_hash)

    const beforePayload = JSON.parse(modified.before_json!)
    const afterPayload = JSON.parse(modified.after_json!)
    expect(beforePayload.title).toBe('AI Tutor - Danish')
    expect(beforePayload.location).toBe('Remote United States')
    expect(afterPayload.location).toBe(MODIFIED_LOCATION)
    expect(beforePayload.company_name).toBe('SpaceXAI') // caveat travels through the pipeline

    // Reproducible from the two snapshots alone: each stored payload
    // re-hashes to its stored content_hash.
    expect(contentHash(beforePayload)).toBe(modified.before_hash!)
    expect(contentHash(afterPayload)).toBe(modified.after_hash!)

    // Provenance lives in columns, not in the hashed payload — a re-fetch
    // of unchanged content must not register as modified.
    expect(beforePayload.source_url).toBeUndefined()
    expect(beforePayload.fetched_at).toBeUndefined()
  })

  test('diff output is deterministic: identical ChangeRow ids and hashes across two runs', () => {
    const run = (reversed: boolean) => {
      const { before, after } = buildBeforeAfter()
      return diff(
        reversed ? [...before].reverse() : before,
        reversed ? [...after].reverse() : after,
        DETECTED_AT,
      )
    }
    const run1 = run(false)
    const run2 = run(true) // input order must not matter

    expect(run1).toHaveLength(3)
    expect(JSON.stringify(run2)).toBe(JSON.stringify(run1)) // byte-identical
    expect(run2.map((c) => c.id)).toEqual(run1.map((c) => c.id))

    for (const c of run1) expect(c.id).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(run1.map((c) => c.id)).size).toBe(3)

    // The id derivation contract: pure function of entity_key + both hashes.
    const removed = run1[0]!
    expect(removed.id).toBe(
      contentHash({
        entity_key: removed.entity_key,
        before_hash: removed.before_hash,
        after_hash: removed.after_hash,
      }),
    )
  })

  test("payload serialization IS contracts' stableStringify — one algorithm, no copy to drift", () => {
    // normalize re-exports the exact function that backs contentHash, so the
    // payload/content_hash round-trip above is true by construction, not by
    // two copies staying in sync.
    expect(stableStringify).toBe(contractsStableStringify)
    expect(stableStringify({ b: 1, a: [null, 'x'], skip: undefined })).toBe(
      '{"a":[null,"x"],"b":1}',
    )
  })
})
