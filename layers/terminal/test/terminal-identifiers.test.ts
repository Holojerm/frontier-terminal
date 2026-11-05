import { describe, expect, it } from 'vitest'

import { COMPANIES } from '../shared/utils/companies'
import { ENTITY_SECURITIES } from '../server/utils/terminal-entities'
import {
  ENTITY_IDENTIFIERS,
  ENTITY_IDENTIFIER_COLUMNS,
  GLEIF_LEIS,
  GLEIF_RECORDS,
  SEC_TICKERS,
  identifiersPayload,
} from '../server/utils/terminal-identifiers'
import { PROVIDER_ORDER } from '../server/utils/terminal-sources'
import { fixtureText, manifest } from './pipeline/fixtures'

// The registry is hand-written, so every identifier in it is checked against
// the response it was read from (fixtures/identifiers/), and every source URL
// and fetch time against the manifest entry for that response.

interface Fetched {
  path: string
  source_url: string
  fetched_at: string
}

const fetches = manifest.fixtures as readonly Fetched[]
const fetchOf = (url: string): Fetched => {
  const hit = fetches.find((f) => f.source_url === url)
  if (!hit) throw new Error(`no fixture fetched from ${url}`)
  return hit
}
const json = <T>(path: string) => JSON.parse(fixtureText(path)) as T

const tickers = json<{ fields: string[]; data: [number, string, string, string | null][] }>(
  'fixtures/identifiers/sec-company-tickers-exchange.json',
)

interface GleifRecord {
  lei: string
  legalName: string
  legalAddress: { country: string }
  jurisdiction: string | null
  registeredAs: string | null
  registrationStatus: string
}
const gleif = json<{ data: GleifRecord[] }>('fixtures/identifiers/gleif-lei-records.json').data

interface FigiCall {
  fetched_at: string
  request: { idValue: string; exchCode?: string; micCode?: string }[]
  response: {
    data?: { figi: string; compositeFIGI: string; shareClassFIGI: string; exchCode: string }[]
  }[]
}
const figiCalls = json<FigiCall[]>('fixtures/identifiers/openfigi-mapping.json')
const figiHit = (ticker: string, key: 'exchCode' | 'micCode', value: string) => {
  for (const call of figiCalls) {
    const at = call.request.findIndex((j) => j.idValue === ticker && j[key] === value)
    if (at >= 0) return { call, data: call.response[at]!.data ?? [] }
  }
  return null
}

/** State of incorporation per CIK, from every submissions feed we hold. */
const SUBMISSIONS = [
  'fixtures/sec/edgar-submissions-msft.json',
  'fixtures/sec/edgar-submissions-amzn.json',
  'fixtures/sec/edgar-submissions-nvda.json',
  'fixtures/sec/edgar-submissions-googl.json',
  'fixtures/sec/edgar-submissions-meta.json',
  'fixtures/sec/edgar-submissions-orcl.json',
  'fixtures/sec/edgar-submissions-spcx.json',
  'fixtures/sec/edgar-submissions-baba.json',
  'fixtures/identifiers/sec-submissions-anthropic.json',
  'fixtures/identifiers/sec-submissions-crwv.json',
  'fixtures/identifiers/sec-submissions-net.json',
  'fixtures/identifiers/sec-submissions-akam.json',
  'fixtures/identifiers/sec-submissions-fsly.json',
  'fixtures/identifiers/sec-submissions-nbis.json',
  'fixtures/identifiers/sec-submissions-docn.json',
].map((p) => json<{ cik: string; stateOfIncorporation: string }>(p))

// EDGAR codes a US state with two letters and a country with a letter and a digit (K3, P7).
const US_STATE = /^[A-Z]{2}$/

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')

describe('ENTITY_IDENTIFIERS', () => {
  it('has one row for every lab, every comparison company, and every entity_securities entity', () => {
    const ids = ENTITY_IDENTIFIERS.map((r) => r.entity_id)
    expect(new Set(ids).size).toBe(ids.length)
    const companies = Object.entries(COMPANIES)
      .filter(([, c]) => c.kind !== 'group')
      .map(([id]) => id)
    for (const id of [...PROVIDER_ORDER, ...companies, ...ENTITY_SECURITIES.map((s) => s.entity)]) {
      expect(ids, id).toContain(id)
    }
    for (const row of ENTITY_IDENTIFIERS) {
      expect(Object.keys(row).sort(), row.entity_id).toEqual([...ENTITY_IDENTIFIER_COLUMNS].sort())
    }
  })

  it('pairs every identifier with its source URL and fetch time, or neither', () => {
    for (const row of ENTITY_IDENTIFIERS) {
      for (const [value, url, at] of [
        [row.cik, row.cik_source_url, row.cik_fetched_at],
        [row.figi, row.figi_source_url, row.figi_fetched_at],
        [row.legal_name, row.source_url, row.fetched_at],
      ] as const) {
        expect(url === null, row.entity_id).toBe(value === null)
        expect(at === null, row.entity_id).toBe(value === null)
      }
      expect(row.lei_note.length, row.entity_id).toBeGreaterThan(20)
      if (row.lei) expect(row.lei_source_url, row.entity_id).toBe(GLEIF_RECORDS.url)
    }
  })

  it('reads every CIK, ticker and exchange off SEC’s ticker file', () => {
    const fetched = fetchOf(SEC_TICKERS.url)
    expect(fetched.fetched_at).toBe(SEC_TICKERS.fetched_at)
    expect(fetched.path).toBe('fixtures/identifiers/sec-company-tickers-exchange.json')
    expect(tickers.fields).toEqual(['cik', 'name', 'ticker', 'exchange'])
    for (const row of ENTITY_IDENTIFIERS.filter((r) => r.cik)) {
      const listed = tickers.data.filter(([cik]) => cik === Number(row.cik))
      expect(listed.length, row.entity_id).toBeGreaterThan(0)
      expect(row.cik, row.entity_id).toMatch(/^\d{10}$/)
      if (!row.ticker) continue
      const line = listed.find(([, , ticker]) => ticker === row.ticker)
      expect(line, row.entity_id).toBeDefined()
      expect(line![3], row.entity_id).toBe(row.exchange)
    }
  })

  it('reads every LEI off GLEIF, with its legal name, country and status', () => {
    const fetched = fetchOf(GLEIF_RECORDS.url)
    expect(fetched.fetched_at).toBe(GLEIF_RECORDS.fetched_at)
    const leis = ENTITY_IDENTIFIERS.flatMap((r) => (r.lei ? [r.lei] : []))
    expect([...leis].sort()).toEqual([...GLEIF_LEIS].sort())
    expect(gleif.map((g) => g.lei).sort()).toEqual([...GLEIF_LEIS].sort())
    for (const row of ENTITY_IDENTIFIERS.filter((r) => r.lei)) {
      const record = gleif.find((g) => g.lei === row.lei)!
      expect(row.legal_name, row.entity_id).toBe(record.legalName)
      expect(row.country, row.entity_id).toBe(record.legalAddress.country)
      expect(row.lei_status, row.entity_id).toBe(record.registrationStatus)
      expect(row.fetched_at, row.entity_id).toBe(GLEIF_RECORDS.fetched_at)
    }
  })

  it('matches a filer’s LEI to the state EDGAR says it is incorporated in', () => {
    let checked = 0
    for (const row of ENTITY_IDENTIFIERS.filter((r) => r.lei && r.cik)) {
      const feed = SUBMISSIONS.find((s) => s.cik === row.cik)
      expect(feed, row.entity_id).toBeDefined()
      const state = feed!.stateOfIncorporation
      if (!US_STATE.test(state)) continue
      expect(gleif.find((g) => g.lei === row.lei)!.jurisdiction, row.entity_id).toBe(`US-${state}`)
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(12)
  })

  it('matches Mistral’s LEI by the registration number its own terms print', () => {
    const mistral = ENTITY_IDENTIFIERS.find((r) => r.entity_id === 'mistral')!
    const record = gleif.find((g) => g.lei === mistral.lei)!
    expect(record.registeredAs).toBe('952418325')
    expect(fixtureText('fixtures/identifiers/mistral-commercial-terms.html')).toContain(
      'Mistral AI, a French limited joint-stock corporation, incorporated in Paris, under number 952 418 325',
    )
  })

  it('takes a legal name without an LEI from the company’s own page', () => {
    for (const row of ENTITY_IDENTIFIERS.filter((r) => !r.lei && r.legal_name)) {
      const fetched = fetchOf(row.source_url!)
      expect(fetched.fetched_at, row.entity_id).toBe(row.fetched_at)
      expect(text(fixtureText(fetched.path)), row.entity_id).toContain(row.legal_name)
    }
    for (const [id, page, words] of [
      ['openai', 'openai-terms-of-use.html', 'OpenAI OpCo, LLC, a Delaware company'],
      ['lambda', 'lambda-terms-of-service.html', 'Lambda, Inc. or its Affiliate'],
    ] as const) {
      expect(text(fixtureText(`fixtures/identifiers/${page}`)), id).toContain(words)
    }
  })

  it('says why an LEI is null, citing the GLEIF search that found none', () => {
    for (const row of ENTITY_IDENTIFIERS.filter((r) => !r.lei && r.lei_source_url)) {
      const fetched = fetchOf(row.lei_source_url!)
      expect(fetched.fetched_at, row.entity_id).toBe(row.lei_fetched_at)
      const search = json<{ data: { legalName: string }[] }>(fetched.path)
      const name = row.legal_name?.toUpperCase()
      if (name) {
        expect(
          search.data.some((d) => d.legalName.toUpperCase() === name),
          row.entity_id,
        ).toBe(false)
      }
    }
    const moonshot = json<{ data: { legalName: string }[] }>(
      'fixtures/identifiers/gleif-search-moonshot-ai.json',
    )
    expect(moonshot.data.map((d) => d.legalName).sort()).toEqual([
      'Moonshot AI HK Limited',
      'Moonshot AI Ltd',
    ])
  })

  it('reads every FIGI off OpenFIGI, and the MIC off a listing OpenFIGI has under it', () => {
    for (const row of ENTITY_IDENTIFIERS.filter((r) => r.ticker)) {
      const composite = figiHit(row.ticker!, 'exchCode', 'US')
      expect(composite, row.entity_id).not.toBeNull()
      expect(composite!.call.fetched_at, row.entity_id).toBe(row.figi_fetched_at)
      expect(composite!.data, row.entity_id).toContainEqual(
        expect.objectContaining({
          figi: row.figi,
          compositeFIGI: row.figi,
          shareClassFIGI: row.share_class_figi,
          exchCode: 'US',
        }),
      )
      const listing = figiHit(row.ticker!, 'micCode', row.mic!)
      expect(
        listing?.data.some((d) => d.compositeFIGI === row.figi),
        row.entity_id,
      ).toBe(true)
    }
    expect(fetchOf('https://api.openfigi.com/v3/mapping').fetched_at).toBe(figiCalls[0]!.fetched_at)
  })

  it('lists no ticker for a company that isn’t listed or registered', () => {
    for (const row of ENTITY_IDENTIFIERS) {
      const trades = row.listing_status === 'listed' || row.listing_status === 'registered'
      expect(row.ticker !== null, row.entity_id).toBe(trades)
    }
  })

  it('serves both registries at /api/identifiers, narrowed to one entity on request', () => {
    const all = identifiersPayload()
    expect(all.identifiers).toHaveLength(ENTITY_IDENTIFIERS.length)
    expect(all.securities).toHaveLength(ENTITY_SECURITIES.length)
    const one = identifiersPayload('anthropic')
    expect(one.identifiers.map((r) => r.entity_id)).toEqual(['anthropic'])
    expect(one.securities.map((s) => s.symbol).sort()).toEqual(['AMZN', 'ANT', 'GOOGL'])
  })
})
