import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { deriveSources, segmentFilings } from '../../server/pipeline/derived'
import type { SourceFetcher } from '../../server/pipeline/fetch'
import { derivedKeyOf, laneFor } from '../../server/pipeline/lanes'
import { parseRevenueFilersBlock } from '../../server/pipeline/parsers/sec/revenue-filers'
import { parseCikWhitelistBlock } from '../../server/pipeline/parsers/sec/whitelist'
import {
  SEGMENT_FIXTURE,
  parseXbrlSegment,
  periodBefore,
  segmentTarget,
} from '../../server/pipeline/parsers/sec/xbrl-segment'
import { runRefresh, type RawStore } from '../../server/pipeline/refresh'
import { sourceIdsForScope } from '../../server/pipeline/scopes'
import { includeSources } from '../../server/pipeline/sources'
import { terminalStamp } from '../../server/utils/terminal-cache'
import { queryContext } from '../../server/utils/terminal-db'
import { queryRevenue, segmentLabel } from '../../server/utils/terminal-revenue'
import { labelOf } from '../../server/utils/terminal-sources'
import { fixtureText, manifest, provenanceOf } from './fixtures'

// Google Cloud segment revenue: Alphabet's per-filing XBRL instance, derived
// from its submissions feed. The parser on the committed 10-Q first, then the
// derivation and the revenue panel end to end against the workerd D1.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const filers = parseRevenueFilersBlock(sourcesYaml)
const whitelist = parseCikWhitelistBlock(sourcesYaml)
const GOOGL_CIK = '0001652044'
const CLOUD = 'goog:GoogleCloudMember'
const xml = fixtureText(SEGMENT_FIXTURE.path)
const target = segmentTarget(SEGMENT_FIXTURE.key, filers, whitelist)

describe('parseXbrlSegment', () => {
  it('reads the four Google Cloud revenue facts once each, skipping consolidated and two-member contexts', () => {
    const { rows, form, period_end } = parseXbrlSegment(
      xml,
      target,
      provenanceOf(SEGMENT_FIXTURE.sourceId),
    )
    expect(form).toBe('10-Q')
    expect(period_end).toBe('2026-09-30')
    expect(rows.map((r) => [r.start, r.end, r.val])).toEqual([
      ['2025-01-01', '2025-09-30', 41_041_000_000],
      ['2025-07-01', '2025-09-30', 15_157_000_000],
      ['2026-01-01', '2026-09-30', 75_505_000_000],
      ['2026-07-01', '2026-09-30', 30_709_000_000],
    ])
    expect(rows[0]).toMatchObject({
      cik: GOOGL_CIK,
      entity_name: 'Alphabet Inc.',
      tag: 'RevenueFromContractWithCustomerExcludingAssessedTax',
      accession_no: '0001652044-26-000084',
      fy: 2026,
      fp: 'Q3',
      form: '10-Q',
      filed: '2026-10-29',
      frame: null,
      segment: CLOUD,
      whitelist_cik: GOOGL_CIK,
    })
  })

  it('refuses an instance for another filer, a renamed member, and two values for one period', () => {
    const prov = provenanceOf(SEGMENT_FIXTURE.sourceId)
    expect(() =>
      parseXbrlSegment(xml, { ...target, cik: '0000789019', ticker: 'MSFT' }, prov),
    ).toThrow('instance is CIK 0001652044, derived for MSFT')
    expect(() =>
      parseXbrlSegment(xml.replaceAll(CLOUD, 'goog:GoogleCloudPlatformMember'), target, prov),
    ).toThrow(
      `no Revenues / RevenueFromContractWithCustomerExcludingAssessedTax / SalesRevenueNet fact on ${CLOUD}`,
    )
    const conflicting = xml.replace('>30709000000<', '>30709000001<')
    expect(() => parseXbrlSegment(conflicting, target, prov)).toThrow('30709000001 and 30709000000')
  })

  it('reads a derived key back against the audited blocks', () => {
    expect(target).toEqual({
      ticker: 'GOOGL',
      cik: GOOGL_CIK,
      segment: CLOUD,
      accession_no: '0001652044-26-000084',
      filed: '2026-10-29',
    })
    expect(() => segmentTarget('spcx-2026-08-04-0001628280-26-052535', filers, whitelist)).toThrow(
      'SPCX is not a segment filer',
    )
    expect(() => segmentTarget('googl-0001652044-26-000084', filers, whitelist)).toThrow(
      'not <ticker>-<filed>-<accession>',
    )
  })

  it('names the period a calendar-year filing covers', () => {
    expect(periodBefore('2026-10-29')).toBe('2026-09-30')
    expect(periodBefore('2026-02-05')).toBe('2025-12-31')
    expect(periodBefore('2026-04-30')).toBe('2026-03-31')
    expect(periodBefore('2026-09-30')).toBe('2026-06-30') // strictly before
  })

  it('treats a fresh filing’s first parse as news and an old one’s as a baseline', () => {
    const lane = laneFor(SEGMENT_FIXTURE.sourceId)!
    const key = derivedKeyOf(SEGMENT_FIXTURE.sourceId)
    expect(key).toBe('googl-2026-10-29-0001652044-26-000084')
    expect(lane.firstIsNews?.(key, '2026-11-01T22:00:00Z')).toBe(true)
    // The back catalogue derived when a filer is first tagged.
    expect(lane.firstIsNews?.(key, '2026-12-01T00:00:00Z')).toBe(false)
    expect(lane.firstIsNews?.(null, '2026-11-01T22:00:00Z')).toBe(false)
  })

  it('labels the member and the derived source', () => {
    expect(segmentLabel(CLOUD)).toBe('Google Cloud')
    expect(laneFor(SEGMENT_FIXTURE.sourceId)).toBeDefined()
    expect(derivedKeyOf(SEGMENT_FIXTURE.sourceId)).toBe(SEGMENT_FIXTURE.key)
    expect(labelOf(SEGMENT_FIXTURE.sourceId)).toEqual({
      label: 'EDGAR XBRL segment facts (GOOGL filing 0001652044-26-000084)',
      role: 'sec',
    })
  })
})

describe('revenue_filers segment', () => {
  it('tags Google as Alphabet’s Google Cloud segment', () => {
    expect(filers.get('google')).toEqual({ ticker: 'GOOGL', relation: 'parent', segment: CLOUD })
  })

  it('reads a segment only off a parent', () => {
    expect(() =>
      parseRevenueFilersBlock(
        'revenue_filers:\n  openai: null\n  anthropic: null\n  google:\n    ticker: GOOGL\n    relation: issuer\n    segment: goog:GoogleCloudMember\n  xai: null\n  meta: null\n',
      ),
    ).toThrow('a segment is only read off a parent')
  })
})

// ── end to end ──────────────────────────────────────────────────────────────

const ALL = includeSources(sourcesYaml, manifest.fixtures)
const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}
let tick = Date.parse('2026-11-01T22:00:00Z')
const now = () => new Date((tick += 1000))

/** Alphabet's committed submissions feed with the 2026-10-29 10-Q the fixture belongs to prepended. */
function submissionsWithQ3(): string {
  const doc = JSON.parse(fixtureText('fixtures/sec/edgar-submissions-googl.json')) as {
    filings: { recent: Record<string, unknown[]> }
  }
  const q3: Record<string, unknown> = {
    accessionNumber: '0001652044-26-000084',
    filingDate: '2026-10-29',
    reportDate: '2026-09-30',
    form: '10-Q',
    primaryDocument: 'goog-20260930.htm',
  }
  for (const [k, list] of Object.entries(doc.filings.recent)) {
    list.unshift(q3[k] ?? (typeof list[0] === 'number' ? 0 : ''))
  }
  return JSON.stringify(doc)
}

const fetcher: SourceFetcher = async (source) => {
  const text =
    source.source_id === 'edgar-submissions-googl'
      ? submissionsWithQ3()
      : source.url ===
          manifest.fixtures.find((f) => f.source_id === SEGMENT_FIXTURE.sourceId)!.source_url
        ? xml
        : undefined
  if (text === undefined) return { ok: false, status: 404, detail: 'HTTP 404' }
  return { ok: true, status: 200, text, bytes: text.length }
}

beforeEach(async () => {
  for (const table of [
    schema.sourceRuns,
    schema.sourceStats,
    schema.alerts,
    schema.changes,
    schema.entities,
    schema.snapshots,
    schema.opsEvents,
  ]) {
    await db.delete(table)
  }
})

describe('Google Cloud segment end to end', () => {
  it('derives one source per recent 10-Q/10-K, on the survey only, and the panel reads it as the parent’s segment', async () => {
    // Before Alphabet's feed is stored nothing derives, and the panel says so.
    expect(await segmentFilings(db, sourcesYaml)).toEqual([])
    await runRefresh({ db, raw, fetcher, sourcesYaml, now }, 'edgar', ['edgar-submissions-googl'])

    const segments = (await deriveSources(db, sourcesYaml)).filter((s) =>
      s.source_id.startsWith('xbrl-segment-'),
    )
    // The real instance names for these three filings (EDGAR, 2026-11-01).
    expect(segments).toEqual([
      {
        source_id: SEGMENT_FIXTURE.sourceId,
        url: 'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000084/goog-20260930_htm.xml',
        ext: 'xml',
      },
      {
        source_id: 'xbrl-segment-googl-2026-07-23-0001652044-26-000071',
        url: 'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000071/goog-20260630_htm.xml',
        ext: 'xml',
      },
      {
        source_id: 'xbrl-segment-googl-2026-04-30-0001652044-26-000048',
        url: 'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000048/goog-20260331_htm.xml',
        ext: 'xml',
      },
    ])
    const all = [...ALL, ...segments]
    expect(sourceIdsForScope('edgar', all)).not.toContain(SEGMENT_FIXTURE.sourceId)
    expect(sourceIdsForScope('survey', all)).toContain(SEGMENT_FIXTURE.sourceId)

    const report = await runRefresh({ db, raw, fetcher, sourcesYaml, now }, 'survey', [
      SEGMENT_FIXTURE.sourceId,
    ])
    // Filed 2026-10-29, read 2026-11-01: a new quarter, so its facts are news.
    expect(report.sources[0]).toMatchObject({ status: 'ok', added: 4 })
    const logged = await db.select().from(schema.changes)
    expect(logged.map((c) => [c.change_type, c.entity_type, c.provider])).toEqual(
      Array(4).fill(['added', 'revenue', 'google']),
    )
    const facts = (await db.select().from(schema.entities)).filter(
      (e) => e.source_id === SEGMENT_FIXTURE.sourceId,
    )
    expect(facts).toHaveLength(4)
    expect(facts.every((e) => e.provider === 'google' && e.entity_type === 'revenue')).toBe(true)
    expect(facts[0]!.entity_key).toMatch(/:goog:GoogleCloudMember$/)

    const ctx = queryContext(sourcesYaml, await terminalStamp(db), () => new Date(tick))
    const google = (await queryRevenue(db, ctx)).providers.find((p) => p.provider === 'google')!
    expect(google.disclosure).toBe('parent')
    expect(google.filer).toMatchObject({
      ticker: 'GOOGL',
      cik: GOOGL_CIK,
      entity_name: 'Alphabet Inc.',
      relation: 'parent',
      segment: CLOUD,
      segment_label: 'Google Cloud',
      source_id: SEGMENT_FIXTURE.sourceId,
    })
    expect(google.filer!.caveat).toContain("not the lab's")
    expect(google.periods.map((p) => [p.start, p.end, p.val])).toEqual([
      ['2026-01-01', '2026-09-30', 75_505_000_000],
      ['2026-07-01', '2026-09-30', 30_709_000_000],
      ['2025-01-01', '2025-09-30', 41_041_000_000],
      ['2025-07-01', '2025-09-30', 15_157_000_000],
    ])
    expect(google.periods[0]!.filing_url).toBe(
      'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000084/',
    )
    expect(google.sources.map((s) => s.source_id)).toEqual([
      SEGMENT_FIXTURE.sourceId,
      'edgar-submissions-googl',
    ])
  })
})
