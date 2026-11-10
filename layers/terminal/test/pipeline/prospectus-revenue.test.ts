import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import {
  deriveSources,
  registrationDocuments,
  registrationFilings,
} from '../../server/pipeline/derived'
import type { SourceFetcher } from '../../server/pipeline/fetch'
import { derivedKeyOf, laneFor } from '../../server/pipeline/lanes'
import {
  REGISTRATION_FIXTURE,
  archivesCik,
  parseFilingIndex,
  registrationKey,
  registrationTarget,
} from '../../server/pipeline/parsers/sec/filing-index'
import { parseProspectusRevenue } from '../../server/pipeline/parsers/sec/prospectus-revenue'
import { filingReview } from '../../server/pipeline/judge/filing-review'
import { submitJudgeRun } from '../../server/pipeline/judge/submit'
import { runRefresh, type RawStore } from '../../server/pipeline/refresh'
import { includeSources } from '../../server/pipeline/sources'
import { terminalStamps } from '../../server/utils/terminal-cache'
import { queryContext } from '../../server/utils/terminal-db'
import { queryRevenue } from '../../server/utils/terminal-revenue'
import { labelOf } from '../../server/utils/terminal-sources'
import { fixtureText, manifest, provenanceOf } from './fixtures'

// Revenue from a lab's own S-1 when the filing tags no financial XBRL: the
// filing index locates the prospectus, and the prospectus's audited
// statement of operations is read. The parsers on Anthropic's S-1 first,
// then the two-hop derivation and the revenue panel end to end.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const ANTHROPIC_CIK = '0002130357'
const ACCESSION = '0001628280-26-067168'
const target = registrationTarget(REGISTRATION_FIXTURE.key)
const indexHtml = fixtureText(REGISTRATION_FIXTURE.indexPath)
const prospectusHtml = fixtureText(REGISTRATION_FIXTURE.prospectusPath)
const prospectusProv = provenanceOf(REGISTRATION_FIXTURE.prospectusSourceId)

describe('registration keys', () => {
  it('round-trips provider, form, filing date and accession', () => {
    expect(registrationKey('anthropic', 'S-1/A', '2026-11-09', ACCESSION)).toBe(
      `anthropic-s-1-a-2026-11-09-${ACCESSION}`,
    )
    expect(registrationTarget(`anthropic-s-1-a-2026-11-09-${ACCESSION}`)).toEqual({
      provider: 'anthropic',
      form: 'S-1/A',
      filed: '2026-11-09',
      accession_no: ACCESSION,
    })
    expect(registrationTarget(REGISTRATION_FIXTURE.key).form).toBe('S-1')
    expect(() => registrationKey('anthropic', '10-Q', '2026-11-09', ACCESSION)).toThrow('10-Q')
    expect(() => registrationTarget('anthropic-2026-10-26')).toThrow('not <provider>')
    expect(archivesCik(prospectusProv.source_url)).toBe(ANTHROPIC_CIK)
  })
})

describe('parseFilingIndex', () => {
  it('names the sequence-1 document whose type is the form; refuses another CIK or form', () => {
    const prov = provenanceOf(REGISTRATION_FIXTURE.indexSourceId)
    expect(parseFilingIndex(indexHtml, target, ANTHROPIC_CIK, prov)).toEqual([
      {
        provider: 'anthropic',
        cik: ANTHROPIC_CIK,
        entity_name: 'Anthropic, PBC',
        accession_no: ACCESSION,
        form: 'S-1',
        filed: '2026-10-26',
        document: 'anthropicpbc-sx1.htm',
        ...prov,
      },
    ])
    expect(() => parseFilingIndex(indexHtml, target, '0001181412', prov)).toThrow(
      'derived for CIK 0001181412',
    )
    expect(() =>
      parseFilingIndex(indexHtml, { ...target, form: 'S-1/A' }, ANTHROPIC_CIK, prov),
    ).toThrow('derived for S-1/A')
  })
})

describe('parseProspectusRevenue', () => {
  it('reads five periods off the audited statement, interim ones unaudited, in dollars', () => {
    const rows = parseProspectusRevenue(prospectusHtml, target, ANTHROPIC_CIK, prospectusProv)
    expect(rows.map((r) => [r.start, r.end, r.val, r.unaudited ?? false])).toEqual([
      ['2023-01-01', '2023-12-31', 41_000_000, false],
      ['2024-01-01', '2024-12-31', 386_000_000, false],
      ['2025-01-01', '2025-06-30', 1_163_000_000, true],
      ['2025-01-01', '2025-12-31', 4_585_000_000, false],
      ['2026-01-01', '2026-06-30', 16_286_000_000, true],
    ])
    expect(rows[0]).toMatchObject({
      cik: ANTHROPIC_CIK,
      entity_name: 'Anthropic, PBC',
      taxonomy: 'prospectus',
      tag: 'Revenue',
      form: 'S-1',
      filed: '2026-10-26',
      accession_no: ACCESSION,
      whitelist_cik: null,
      ...prospectusProv,
    })
    // An annual row carries no unaudited key at all, so its hash matches an XBRL-shaped row's.
    expect('unaudited' in rows[0]!).toBe(false)
  })

  it('skips an index entry, and refuses a document with no statement or two that disagree', () => {
    const [index] = prospectusHtml.split('<!--', 1)
    expect(() =>
      parseProspectusRevenue(index ?? '', target, ANTHROPIC_CIK, prospectusProv),
    ).toThrow('no Consolidated Statements of Operations')
    const tocOnly = prospectusHtml.slice(
      0,
      prospectusHtml.lastIndexOf('Consolidated Statements of Operations'),
    )
    expect(() => parseProspectusRevenue(tocOnly, target, ANTHROPIC_CIK, prospectusProv)).toThrow(
      'no Consolidated Statements of Operations',
    )
    const altered = prospectusHtml.replace('>4,585<', '>4,586<')
    expect(() =>
      parseProspectusRevenue(prospectusHtml + altered, target, ANTHROPIC_CIK, prospectusProv),
    ).toThrow('disagree')
  })
})

// ── end to end ──────────────────────────────────────────────────────────────

const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}
let tick = Date.parse('2026-11-02T04:00:00Z')
const now = () => new Date((tick += 1000))
const run = (ids: readonly string[], fetcher: SourceFetcher) =>
  runRefresh({ db, raw, fetcher, sourcesYaml, now }, 'survey', ids)

/** Anthropic's S-1 as the full-text search and its own submissions feed list it. */
function fetcher(prospectus = prospectusHtml): SourceFetcher {
  const byUrl = new Map(manifest.fixtures.map((f) => [f.source_url, fixtureText(f.path)]))
  byUrl.set(prospectusProv.source_url, prospectus)
  const fts = JSON.parse(fixtureText('fixtures/sec/edgar-fts.json')) as {
    hits: { hits: unknown[] }
  }
  const s1 = {
    _source: {
      adsh: ACCESSION,
      form: 'S-1',
      file_date: '2026-10-26',
      ciks: [ANTHROPIC_CIK],
      display_names: [`Anthropic, PBC  (CIK ${ANTHROPIC_CIK})`],
    },
  }
  const ftsUrl = includeSources(sourcesYaml, manifest.fixtures).find(
    (s) => s.source_id === 'edgar-fts',
  )!.url
  byUrl.set(ftsUrl, JSON.stringify({ ...fts, hits: { ...fts.hits, hits: [s1, ...fts.hits.hits] } }))
  byUrl.set(
    `https://data.sec.gov/submissions/CIK${ANTHROPIC_CIK}.json`,
    JSON.stringify({
      cik: ANTHROPIC_CIK,
      name: 'Anthropic, PBC',
      filings: {
        recent: {
          accessionNumber: [ACCESSION, '0001628280-26-064010'],
          form: ['S-1', 'DRS/A'],
          filingDate: ['2026-10-26', '2026-10-09'],
        },
      },
    }),
  )
  return async (source) => {
    const text = byUrl.get(source.url)
    if (text === undefined) return { ok: false, status: 404, detail: 'HTTP 404' }
    return { ok: true, status: 200, text, bytes: text.length }
  }
}

const ctx = async () =>
  queryContext(sourcesYaml, (await terminalStamps(db)).poll, () => new Date('2026-11-02T12:00:00Z'))

beforeEach(async () => {
  for (const table of [
    schema.sourceRuns,
    schema.sourceStats,
    schema.alerts,
    schema.changes,
    schema.entities,
    schema.snapshots,
    schema.opsEvents,
    schema.filingReadings,
    schema.judgeRuns,
  ]) {
    await db.delete(table)
  }
})

describe('S-1 revenue end to end', () => {
  it('resolves the lab, locates the prospectus, and shows its audited revenue on the panel', async () => {
    const f = fetcher()
    await run(['edgar-fts'], f)
    await run(['edgar-submissions-anthropic'], f)
    expect(await registrationFilings(db)).toEqual([
      {
        provider: 'anthropic',
        cik: ANTHROPIC_CIK,
        form: 'S-1',
        accession_no: ACCESSION,
        file_date: '2026-10-26',
      },
    ])

    // Hop one: the filing index, on the survey (not an edgar- id).
    const indexSource = (await deriveSources(db, sourcesYaml)).find((s) =>
      s.source_id.startsWith('filing-index-'),
    )!
    expect(indexSource).toEqual({
      source_id: REGISTRATION_FIXTURE.indexSourceId,
      url: provenanceOf(REGISTRATION_FIXTURE.indexSourceId).source_url,
      ext: 'html',
    })
    expect(laneFor(indexSource.source_id)).toBeDefined()
    expect(derivedKeyOf(indexSource.source_id)).toBe(REGISTRATION_FIXTURE.key)
    expect(labelOf(indexSource.source_id).label).toBe(
      `EDGAR filing index (anthropic S-1, ${ACCESSION})`,
    )
    await run([indexSource.source_id], f)
    expect((await registrationDocuments(db)).map((d) => d.document)).toEqual([
      'anthropicpbc-sx1.htm',
    ])

    // Hop two: the prospectus itself.
    const prospectus = (await deriveSources(db, sourcesYaml)).find((s) =>
      s.source_id.startsWith('prospectus-revenue-'),
    )!
    expect(prospectus).toEqual({
      source_id: REGISTRATION_FIXTURE.prospectusSourceId,
      url: prospectusProv.source_url,
      ext: 'html',
    })
    // A registration document is its own source: its first parse is the
    // filing itself, so it records changes and alerts rather than baselining.
    const report = await run([prospectus.source_id], f)
    expect(report.sources[0]).toMatchObject({ status: 'ok', alerts: 1 })
    const [alert] = await db.select().from(schema.alerts)
    expect(alert).toMatchObject({ rule: 'prospectus-floor', severity: 'notable' })
    expect(alert!.headline).toBe(
      'Anthropic, PBC S-1: $16,286 million revenue for the six months ended 2026-06-30; price range still blank',
    )
    expect(alert!.explanation).toContain(
      'against $1,163 million a year earlier (unaudited). The cover lists the Nasdaq Global Select Market under the symbol “ANT”.',
    )
    expect(alert!.explanation).toContain('the roadshow has not launched')

    const revenue = await queryRevenue(db, await ctx())
    const anthropic = revenue.providers.find((p) => p.provider === 'anthropic')!
    expect(anthropic.disclosure).toBe('issuer')
    expect(anthropic.periods.map((p) => [p.end, p.days, p.val, p.basis, p.unaudited])).toEqual([
      ['2026-06-30', 181, 16_286_000_000, 'prospectus', true],
      ['2025-12-31', 365, 4_585_000_000, 'prospectus', false],
      ['2025-06-30', 181, 1_163_000_000, 'prospectus', true],
      ['2024-12-31', 366, 386_000_000, 'prospectus', false],
      ['2023-12-31', 365, 41_000_000, 'prospectus', false],
    ])
    expect(anthropic.periods[0]!.filing_url).toBe(
      `https://www.sec.gov/Archives/edgar/data/2130357/000162828026067168/`,
    )
    // A statement row label is not an XBRL tag.
    expect(anthropic.tags).toEqual([])
    expect(anthropic.sources[0]!.source_id).toBe(REGISTRATION_FIXTURE.prospectusSourceId)
    expect(anthropic.filer!.caveat).toContain('tags no financial XBRL')
    expect(revenue.rule).toContain('printed statement of operations')
  })

  it('stores the parts that read and alerts on them when one part does not, then reads it again', async () => {
    // The 2026-11-10 failure: a share-count sentence reworded past the parser.
    const reworded = prospectusHtml.replace(
      'outstanding after this offering is based on',
      'outstanding after this offering will be based on',
    )
    expect(reworded).not.toBe(prospectusHtml)
    const f = fetcher(reworded)
    await run(['edgar-fts'], f)
    await run(['edgar-submissions-anthropic'], f)
    await run([REGISTRATION_FIXTURE.indexSourceId], f)

    const first = await run([REGISTRATION_FIXTURE.prospectusSourceId], f)
    expect(first.sources[0]).toMatchObject({ status: 'ok', alerts: 1 })
    expect(first.sources[0]!.detail).toContain('not read: shares')
    const [alert] = await db.select().from(schema.alerts)
    expect(alert!.headline).toContain('$16,286 million revenue for the six months ended 2026-06-30')
    const entities = await db.select().from(schema.entities)
    expect(entities.some((e) => e.entity_type === 'revenue')).toBe(true)
    expect(entities.some((e) => e.entity_type === 'shares')).toBe(false)
    const spooled = async () =>
      (await db.select().from(schema.opsEvents)).filter((e) => e.kind === 'source_part_failed')
    expect((await spooled()).map((e) => e.detail)).toEqual([
      `${REGISTRATION_FIXTURE.prospectusSourceId}: shares: "The Offering" states no pre-offering basis`,
    ])

    // Same bytes next tick: an incomplete read is read again, never 'unchanged'.
    const second = await run([REGISTRATION_FIXTURE.prospectusSourceId], f)
    expect(second.sources[0]).toMatchObject({ status: 'ok', alerts: 0 })
    expect(await spooled()).toHaveLength(2)
  })

  it('has the judge read revenue the parser could not, from a sentence the Worker finds in the filing', async () => {
    const SENTENCE =
      'Our revenue was $16.3 billion for the six months ended June 30, 2026, compared to $1.2 billion for the six months ended June 30, 2025.'
    // The statement is retitled past the parser, and the filing says its revenue in prose.
    const broken =
      prospectusHtml.replace(
        />(\s*)Consolidated Statements of Operations(\s*)</g,
        '>$1Statements of Results$2<',
      ) + `<div style="line-height:12pt"><font style="font-size:10pt">${SENTENCE}</font></div>`
    expect(broken).toContain(SENTENCE)
    const f = fetcher(broken)
    await run(['edgar-fts'], f)
    await run(['edgar-submissions-anthropic'], f)
    await run([REGISTRATION_FIXTURE.indexSourceId], f)
    const read = await run([REGISTRATION_FIXTURE.prospectusSourceId], f)
    expect(read.sources[0]!.detail).toContain('not read: statements, revenue')

    const readRaw = async (key: string) => (await env.BLOB.get(key))?.text() ?? null
    const NOW = new Date('2026-11-02T12:00:00Z')
    const [review, ...none] = await filingReview(db, readRaw, NOW)
    expect(none).toEqual([])
    expect(review).toMatchObject({
      source_id: REGISTRATION_FIXTURE.prospectusSourceId,
      accession_no: ACCESSION,
      parts: [{ part: 'revenue' }],
    })
    expect(review!.excerpts.join(' ')).toContain(SENTENCE)

    const submit = (filings: unknown[]) =>
      submitJudgeRun(
        db,
        JSON.stringify({
          alerts: [],
          filings,
          judged_through: '2026-11-02T04:00:00.000Z',
          change_ids_seen: [],
        }),
        { readRaw, now: NOW },
      )
    const reading = {
      source_id: REGISTRATION_FIXTURE.prospectusSourceId,
      part: 'revenue',
      quote: SENTENCE,
      amount: '$16.3 billion',
      months: 6,
      period_end: '2026-06-30',
    }
    // Invented words, an earlier period, or the other period's amount are dropped.
    const bad = await submit([
      {
        ...reading,
        quote: 'Our revenue was $99.0 billion for the six months ended June 30, 2026.',
        amount: '$99.0 billion',
      },
    ])
    expect(bad.filings).toMatchObject({
      accepted: 0,
      rejected: [{ reason: 'quote-not-in-document' }],
    })
    const stale = await submit([{ ...reading, amount: '$1.2 billion', period_end: '2025-06-30' }])
    expect(stale.filings.rejected).toMatchObject([{ reason: 'not-the-latest-period' }])
    const swapped = await submit([{ ...reading, amount: '$1.2 billion' }])
    expect(swapped.filings.rejected).toMatchObject([{ reason: 'amount-not-for-period' }])

    const ok = await submit([reading])
    expect(ok.filings).toEqual({ accepted: 1, alerts: 1, rejected: [] })
    const alerts = await db.select().from(schema.alerts)
    const judged = alerts.find((a) => a.explanation.includes('the judge read'))!
    expect(judged).toMatchObject({ rule: 'prospectus-floor', severity: 'notable' })
    expect(judged.headline).toBe(
      'Anthropic, PBC S-1: $16,300 million revenue for the six months ended 2026-06-30',
    )
    expect(judged.explanation).toContain(`“${SENTENCE}”`)
    const [stored] = await db.select().from(schema.filingReadings)
    expect(JSON.parse(stored!.values)).toEqual({
      val: 16_300_000_000,
      months: 6,
      end: '2026-06-30',
      amount: '$16.3 billion',
    })
    // Read once: the filing is no longer offered, and a second reading is not offered either.
    expect(await filingReview(db, readRaw, NOW)).toEqual([])
    expect((await submit([reading])).filings.rejected).toMatchObject([{ reason: 'not-offered' }])
  })
})
