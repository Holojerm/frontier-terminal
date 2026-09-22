import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { parseEdgarCompanyfacts } from '../server/pipeline/parsers/sec/edgar-companyfacts'
import {
  parseRevenueFilersBlock,
  revenueProviderFor,
} from '../server/pipeline/parsers/sec/revenue-filers'
import { parseCikWhitelistBlock } from '../server/pipeline/parsers/sec/whitelist'
import type { SourceFetcher } from '../server/pipeline/fetch'
import { runRefresh, type RawStore } from '../server/pipeline/refresh'
import { includeSources } from '../server/pipeline/sources'
import { terminalStamp } from '../server/utils/terminal-cache'
import { queryContext } from '../server/utils/terminal-db'
import {
  filingIndexUrl,
  queryRevenue,
  revenuePeriodFromPayload,
  splitPeriods,
} from '../server/utils/terminal-revenue'
import { fixtureText, manifest, provenanceOf } from './pipeline/fixtures'

// The disclosed-revenue axis: the company-facts parser on its committed
// fixture, the revenue_filers reader, the period arithmetic as a pure
// function, and the query against a D1 seeded through runRefresh.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const whitelist = parseCikWhitelistBlock(sourcesYaml)
const filers = parseRevenueFilersBlock(sourcesYaml)
const SPCX_CIK = '0001181412'

describe('revenue_filers', () => {
  it('reads the block: three nulls and SPCX as xAI’s parent', () => {
    expect([...filers.entries()]).toEqual([
      ['openai', null],
      ['anthropic', null],
      ['google', null],
      ['xai', { ticker: 'SPCX', relation: 'parent' }],
    ])
    expect(revenueProviderFor(SPCX_CIK, filers, whitelist)).toBe('xai')
    expect(revenueProviderFor('0000789019', filers, whitelist)).toBe('other') // MSFT: whitelisted, not a filer
  })

  it('refuses a drifted block instead of silently untagging a filer', () => {
    expect(() => parseRevenueFilersBlock('revenue_filers:\n  xai:\n    ticker: SPCX\n')).toThrow(
      'needs both ticker and relation',
    )
    expect(() =>
      parseRevenueFilersBlock('revenue_filers:\n  xai:\n    ticker: SPCX\n    relation: cousin\n'),
    ).toThrow('issuer or parent')
    expect(() => parseRevenueFilersBlock('revenue_filers:\n  openai: null\n')).toThrow(
      'no entry for anthropic',
    )
    expect(() => parseRevenueFilersBlock('revenue_filers:\n  mistral: null\n')).toThrow(
      'unknown provider mistral',
    )
  })
})

describe('parseEdgarCompanyfacts', () => {
  it('emits one row per duration revenue fact, tag named, values unscaled', () => {
    const { rows, tags } = parseEdgarCompanyfacts(
      fixtureText('fixtures/sec/edgar-companyfacts-spcx.json'),
      whitelist,
      provenanceOf('edgar-companyfacts-spcx'),
    )
    expect(tags).toEqual(['RevenueFromContractWithCustomerExcludingAssessedTax'])
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.cik === SPCX_CIK && r.whitelist_cik === SPCX_CIK)).toBe(true)
    expect(rows.every((r) => r.form === '10-Q' && r.accession_no === '0001628280-26-052535')).toBe(
      true,
    )
    expect(rows.map((r) => [r.start, r.end, r.val, r.frame])).toEqual([
      ['2025-01-01', '2025-06-30', 8_138_000_000, null],
      ['2025-04-01', '2025-06-30', 4_071_000_000, 'CY2025Q2'],
      ['2026-01-01', '2026-06-30', 12_508_000_000, null],
      ['2026-04-01', '2026-06-30', 7_814_000_000, 'CY2026Q2'],
    ])
    expect(rows[0]!.entity_name).toBe('SPACE EXPLORATION TECHNOLOGIES CORP.')
  })
})

describe('splitPeriods', () => {
  const prov = {
    source_url: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0001181412.json',
    fetched_at: '2026-09-22T03:14:11Z',
  }
  const fact = (
    start: string,
    end: string,
    val: number,
    accn: string,
    filed: string,
    tag = 'Revenues',
  ) =>
    revenuePeriodFromPayload(
      `revenue:${SPCX_CIK}:${tag}:${accn}:${start}:${end}`,
      JSON.stringify({
        cik: SPCX_CIK,
        entity_name: 'X',
        tag,
        start,
        end,
        val,
        accession_no: accn,
        fy: 2026,
        fp: 'Q2',
        form: '10-Q',
        filed,
        frame: null,
      }),
      prov,
    )!

  it('shows each period from its newest filing, lists the restated value, orders newest end first', () => {
    const q2 = fact('2026-04-01', '2026-06-30', 100, '0000000000-26-000002', '2026-08-04')
    const h1 = fact('2026-01-01', '2026-06-30', 180, '0000000000-26-000002', '2026-08-04')
    const q1old = fact('2026-01-01', '2026-03-31', 80, '0000000000-26-000001', '2026-05-04')
    const q1new = fact('2026-01-01', '2026-03-31', 81, '0000000000-26-000002', '2026-08-04')
    const out = splitPeriods([q1old, q2, h1, q1new])
    expect(out.periods.map((p) => [p.start, p.end, p.val])).toEqual([
      ['2026-01-01', '2026-06-30', 180], // the half above its final quarter
      ['2026-04-01', '2026-06-30', 100],
      ['2026-01-01', '2026-03-31', 81],
    ])
    expect(out.superseded.map((p) => p.val)).toEqual([80])
    expect(out.periods[1]!.days).toBe(91)
    expect(out.periods[0]!.days).toBe(181)
    expect(out.periods[0]!.filing_url).toBe(
      'https://www.sec.gov/Archives/edgar/data/1181412/000000000026000002/',
    )
  })

  it('within one filing the preferred tag wins', () => {
    const a = fact(
      '2026-04-01',
      '2026-06-30',
      100,
      '0000000000-26-000002',
      '2026-08-04',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
    )
    const b = fact(
      '2026-04-01',
      '2026-06-30',
      100,
      '0000000000-26-000002',
      '2026-08-04',
      'Revenues',
    )
    const out = splitPeriods([a, b])
    expect(out.periods[0]!.tag).toBe('Revenues')
    expect(out.tags).toEqual(['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax'])
  })

  it('composes the EDGAR filing index from cik and accession', () => {
    expect(filingIndexUrl(SPCX_CIK, '0001628280-26-052535')).toBe(
      'https://www.sec.gov/Archives/edgar/data/1181412/000162828026052535/',
    )
  })
})

describe('queryRevenue against a seeded store', () => {
  const ALL = includeSources(sourcesYaml, manifest.fixtures)
  const raw: RawStore = {
    put: async (key, body, contentType) => {
      await env.BLOB.put(key, body, { httpMetadata: { contentType } })
    },
  }
  const fetcher: SourceFetcher = async (source) => {
    const f = manifest.fixtures.find((x) => x.source_url === source.url)!
    const text = fixtureText(f.path)
    return { ok: true, status: 200, text, bytes: text.length }
  }
  let tick = Date.parse('2026-09-07T10:00:00Z')
  const now = () => new Date((tick += 1000))

  beforeAll(async () => {
    await runRefresh({ db, raw, fetcher, sourcesYaml, now }, 'edgar', [
      'edgar-companyfacts-spcx',
      'edgar-submissions-spcx',
    ])
  })

  it('three labs say no disclosure; xAI carries SpaceX’s consolidated series as the parent’s', async () => {
    const ctx = queryContext(
      sourcesYaml,
      await terminalStamp(db),
      () => new Date('2026-09-07T12:00:00Z'),
    )
    const revenue = await queryRevenue(db, ctx)
    expect(revenue.rule).toContain('deliberately not shown')
    const by = Object.fromEntries(revenue.providers.map((p) => [p.provider, p]))
    for (const p of ['openai', 'anthropic', 'google'] as const) {
      expect(by[p]).toMatchObject({ disclosure: 'none', filer: null, periods: [], sources: [] })
    }
    const xai = by.xai!
    expect(xai.disclosure).toBe('parent')
    expect(xai.filer).toMatchObject({
      ticker: 'SPCX',
      cik: SPCX_CIK,
      relation: 'parent',
      entity_name: 'SPACE EXPLORATION TECHNOLOGIES CORP.',
      source_id: 'edgar-companyfacts-spcx',
    })
    expect(xai.filer!.caveat).toContain('not xAI')
    expect(xai.periods.map((p) => [p.start, p.end, p.val])).toEqual([
      ['2026-01-01', '2026-06-30', 12_508_000_000],
      ['2026-04-01', '2026-06-30', 7_814_000_000],
      ['2025-01-01', '2025-06-30', 8_138_000_000],
      ['2025-04-01', '2025-06-30', 4_071_000_000],
    ])
    expect(xai.superseded).toEqual([])
    expect(xai.tags).toEqual(['RevenueFromContractWithCustomerExcludingAssessedTax'])
    // Live provenance from the seeded fetch, not the manifest.
    expect(xai.periods[0]!.source_url).toBe(
      ALL.find((s) => s.source_id === 'edgar-companyfacts-spcx')!.url,
    )
    expect(xai.periods[0]!.fetched_at).toMatch(/^2026-09-07T10:0\d:/)
    expect(xai.sources.map((s) => s.source_id)).toEqual([
      'edgar-companyfacts-spcx',
      'edgar-submissions-spcx',
    ])
  })
})
