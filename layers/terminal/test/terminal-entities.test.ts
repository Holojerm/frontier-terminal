import { describe, expect, it } from 'vitest'

import { parseCikWhitelistBlock } from '../server/pipeline/parsers/sec/whitelist'
import { SEC_REVENUE_CRWV } from '../server/theses/recipes/sec-revenue'
import {
  DISCLOSED,
  ENTITY_SECURITIES,
  ENTITY_SECURITY_COLUMNS,
} from '../server/utils/terminal-entities'
import { PROVIDER_ORDER } from '../server/utils/terminal-sources'
import { fixtureText, manifest } from './pipeline/fixtures'

// The security map is hand-written, so every number in it is checked against
// what the terminal already stores: a CIK against sources.yaml or a recipe, a
// symbol and exchange against EDGAR's own submissions feed for that CIK.

const whitelist = parseCikWhitelistBlock(fixtureText('sources.yaml'))
const whitelisted = new Set([...whitelist.values()])

const SUBMISSIONS: Record<string, string> = {
  '0000789019': 'fixtures/sec/edgar-submissions-msft.json',
  '0001018724': 'fixtures/sec/edgar-submissions-amzn.json',
  '0001045810': 'fixtures/sec/edgar-submissions-nvda.json',
  '0001652044': 'fixtures/sec/edgar-submissions-googl.json',
  '0001326801': 'fixtures/sec/edgar-submissions-meta.json',
  '0001341439': 'fixtures/sec/edgar-submissions-orcl.json',
  '0001181412': 'fixtures/sec/edgar-submissions-spcx.json',
  '0001577552': 'fixtures/sec/edgar-submissions-baba.json',
}

describe('ENTITY_SECURITIES', () => {
  it('has a row for every tracked lab', () => {
    for (const lab of PROVIDER_ORDER) {
      expect(
        ENTITY_SECURITIES.some((r) => r.entity === lab && r.entity_kind === 'lab'),
        lab,
      ).toBe(true)
    }
  })

  it('carries every column on every row, with a source', () => {
    for (const row of ENTITY_SECURITIES) {
      expect(Object.keys(row).sort()).toEqual([...ENTITY_SECURITY_COLUMNS].sort())
      expect(row.source_url).toMatch(/^https:\/\//)
      expect(row.checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('says private when there is no security, and names one otherwise', () => {
    for (const row of ENTITY_SECURITIES) {
      if (row.listing_status === 'private') {
        expect(row).toMatchObject({ relationship: 'none', cik: null, symbol: null })
      } else {
        expect(row.symbol, row.entity).toBeTruthy()
        expect(row.cik, row.entity).toMatch(/^\d{10}$/)
      }
    }
  })

  it('reads every listed symbol and exchange off EDGAR’s feed for that CIK', () => {
    for (const row of ENTITY_SECURITIES.filter((r) => r.cik && SUBMISSIONS[r.cik])) {
      const feed = JSON.parse(fixtureText(SUBMISSIONS[row.cik!]!)) as {
        cik: string
        name: string
        tickers: string[]
        exchanges: string[]
      }
      expect(feed.cik, row.symbol!).toBe(row.cik)
      expect(feed.name, row.symbol!).toBe(row.issuer)
      const at = feed.tickers.indexOf(row.symbol!)
      expect(at, row.symbol!).toBeGreaterThanOrEqual(0)
      expect(feed.exchanges[at], row.symbol!).toBe(row.exchange)
      expect(whitelisted.has(row.cik), row.symbol!).toBe(true)
    }
  })

  it('takes the other CIKs from the recipe or the lab’s own S-1, never from memory', () => {
    const crwv = ENTITY_SECURITIES.find((r) => r.symbol === 'CRWV')!
    expect(SEC_REVENUE_CRWV.url({ now: new Date(), newest: null })).toContain(`CIK${crwv.cik}`)

    const ant = ENTITY_SECURITIES.find((r) => r.symbol === 'ANT')!
    expect(ant.listing_status).toBe('registered')
    const index = fixtureText('fixtures/sec/filing-index-anthropic-s-1.html')
    expect(index).toContain(`cik=${Number(ant.cik)}`)
    const prospectus = fixtureText('fixtures/sec/prospectus-anthropic-s-1.html')
      .replace(/<[^>]+>/g, '')
      .replace(/&#160;|&nbsp;/g, ' ')
      .replace(/&#8220;/g, '“')
      .replace(/&#8221;/g, '”')
    expect(prospectus).toMatch(/Nasdaq Global Select Market\s*under the\s*symbol\s*“ANT\.”/)
  })

  it('gives each security the MIC and FIGI OpenFIGI lists for its symbol', () => {
    const calls = JSON.parse(fixtureText('fixtures/identifiers/openfigi-mapping.json')) as {
      request: { idValue: string; exchCode?: string; micCode?: string }[]
      response: { data?: { figi: string; compositeFIGI: string }[] }[]
    }[]
    const hit = (symbol: string, key: 'exchCode' | 'micCode', value: string) =>
      calls.flatMap((c) =>
        c.request.flatMap((j, i) =>
          j.idValue === symbol && j[key] === value ? (c.response[i]!.data ?? []) : [],
        ),
      )
    for (const row of ENTITY_SECURITIES) {
      if (!row.symbol) {
        expect(row.figi, row.entity).toBeNull()
        continue
      }
      expect(
        hit(row.symbol, 'exchCode', 'US').map((d) => d.figi),
        row.symbol,
      ).toContain(row.figi)
      expect(
        hit(row.symbol, 'micCode', row.mic!).map((d) => d.compositeFIGI),
        row.symbol,
      ).toContain(row.figi)
    }
  })

  // The evidence each parent or investor row rests on, in the filing it cites.
  const EVIDENCE: Record<string, RegExp> = {
    [DISCLOSED.msftOpenai]: /msft:OpenAIGlobalLlcMember/,
    [DISCLOSED.amznAnthropic]: /amzn:AnthropicMember/,
    [DISCLOSED.anthropicNotePurchase]:
      /NPAs with each of Google \(through Google LLC\), Amazon \(through Amazon Web Services, Inc\.\)/,
    [DISCLOSED.alphabetSubsidiaries]: /Google LLC\s+Delaware/,
    [DISCLOSED.spacexMerger]:
      /xAI will continue as the surviving entity of the First Merger .* as a wholly owned subsidiary of SpaceX\./,
    [DISCLOSED.alibabaSubsidiaries]: /Alibaba Cloud Computing Ltd\. \(PRC\)/,
  }

  it('cites the filing that discloses every parent and investor, and says what it shows', () => {
    const manifestFixtures = manifest.fixtures as { path: string; source_url: string }[]
    for (const row of ENTITY_SECURITIES) {
      if (row.relationship === 'self' || row.relationship === 'none') {
        expect(row.disclosed_in, `${row.entity} ${row.symbol}`).toBeNull()
        continue
      }
      // A filing can have more than one excerpt committed; one of them shows it.
      const url = row.disclosed_in!
      const bodies = manifestFixtures
        .filter((f) => f.source_url === url)
        .map((f) =>
          fixtureText(f.path)
            .replace(/<[^>]+>/g, ' ')
            .replace(/&#8220;|&#8221;/g, '"')
            .replace(/&#160;|&nbsp;/g, ' ')
            .replace(/\s+/g, ' '),
        )
      expect(bodies.length, url).toBeGreaterThan(0)
      expect(
        bodies.some((b) => EVIDENCE[url]!.test(b)),
        url,
      ).toBe(true)
    }
  })
})
