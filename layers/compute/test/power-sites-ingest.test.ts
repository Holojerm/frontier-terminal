import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import epochTimelines from '~~/fixtures/recipes/epoch-data-center-timelines.csv?raw'
import epochSites from '~~/fixtures/recipes/epoch-data-centers.csv?raw'
import * as schema from '~~/server/db/schema'
import { contentHash } from '#layers/core/server/pipeline/contracts/keys'
import type { FetchOutcome, SourceFetcher } from '#layers/core/server/pipeline/fetch'
import { mwWritten, powerExcerpts, roleStated } from '../server/power/excerpts'
import { filerOf, runPowerSiteReads, searchHits, searchUrl, sitesDue } from '../server/power/ingest'
import {
  applyPowerSiteReadings,
  checkTie,
  listingOf,
  powerSiteReview,
} from '../server/power/review'
import { epochLabSites, searchFor, searchQuery } from '../server/power/sites'
import { currentTies, formOf, handTies, powerTiesStamp, seedHandTies } from '../server/power/store'
import { verifyHandTies } from '../server/power/verify'
import {
  EPOCH_DATA_CENTERS,
  EPOCH_DATA_CENTER_TIMELINES,
} from '../server/recipes/epoch-data-centers'
import { runRecipes } from '#layers/core/server/recipes/run'
import { queryPowerSites } from '../server/utils/terminal-datacenters'

// The power-sites reader end to end on a made-up filing: the hand-read rows
// seed the table, EDGAR full-text search finds TeraWulf's next 10-Q naming
// Lake Mariner, it is offered to the judge, and what the judge sends back is
// checked against the stored filing before the table moves. Then the weekly
// re-read of the pages off EDGAR, and the pure checks on their own.

const db = drizzle(env.DB, { schema })
const HAND = handTies()
const SITE = 'Anthropic Lake Mariner'

const NEW_10Q = '0001083301-27-000041'
const DOC_ID = `${NEW_10Q}:wulf-20270331.htm`
const NEW_10Q_URL =
  'https://www.sec.gov/Archives/edgar/data/1083301/000108330127000041/wulf-20270331.htm'
const NOW = new Date('2027-05-08T12:00:00Z')

const hit = (id: string, form: string, file_type: string, file_date: string) => ({
  _id: id,
  _source: {
    ciks: ['0001083301'],
    display_names: ['TERAWULF INC.  (WULF)  (CIK 0001083301)'],
    form,
    file_type,
    file_date,
  },
})

const SEARCH = JSON.stringify({
  hits: {
    hits: [
      hit(DOC_ID, '10-Q', '10-Q', '2027-05-07'),
      // A contract exhibit and a PDF are not read.
      hit(`${NEW_10Q}:wulf-ex10_1.htm`, '10-Q', 'EX-10.1', '2027-05-07'),
      hit('0001083301-27-000040:deck.pdf', '8-K', 'EX-99.2', '2027-05-06'),
    ],
  },
})
const EMPTY = JSON.stringify({ hits: { hits: [] } })

/**
 * TeraWulf's next 10-Q: the 500 MW sentence and the grid sentence repeated
 * word for word, the NYPA sentence gone, and a new utility tie.
 */
const NEW_10Q_HTML = `<html><body>
<p>Risk factors. Bitcoin prices are volatile.</p>
<p>The Lake Mariner Data Campus, with approximately 500 MW of aggregate gross capacity expected to be energized by early 2027, and planned expansion to approximately 750 MW, supported by an approved NYISO System Impact Study, continues to grow.</p>
<p>The Lake Mariner Data Campus sources power from the NYISO Zone A grid, which is characterized by low-cost, low-carbon energy.</p>
<p>In March 2027, National Grid agreed to provide electric service of an additional 250 MW to the Lake Mariner Data Campus through a new 345 kV substation.</p>
</body></html>`

const raw = new Map<string, string>()
const rawStore = {
  put: async (key: string, body: string) => {
    raw.set(key, body)
    await env.BLOB.put(key, body)
  },
}
const readRaw = async (key: string) => raw.get(key) ?? null

const ok = (text: string): FetchOutcome => ({ ok: true, status: 200, text, bytes: text.length })
const EPOCH: Record<string, string> = {}

const fetcher: SourceFetcher = async (source) => {
  if (EPOCH[source.url]) return ok(EPOCH[source.url]!)
  if (source.url.startsWith('https://efts.sec.gov/')) {
    return ok(source.url.includes(encodeURIComponent('"Lake Mariner"')) ? SEARCH : EMPTY)
  }
  if (source.url === NEW_10Q_URL) return ok(NEW_10Q_HTML)
  return { ok: false, status: 404, detail: 'HTTP 404' }
}

beforeAll(async () => {
  const epochAt = new Date('2026-11-04T12:00:00Z')
  EPOCH[EPOCH_DATA_CENTERS.url(epochAt)] = epochSites
  EPOCH[EPOCH_DATA_CENTER_TIMELINES.url(epochAt)] = epochTimelines
  await runRecipes(db, { raw: rawStore, fetcher, now: () => epochAt }, [
    EPOCH_DATA_CENTERS,
    EPOCH_DATA_CENTER_TIMELINES,
  ])
})

beforeEach(async () => {
  raw.clear()
  for (const table of [schema.powerSiteTies, schema.powerSiteDocuments, schema.opsEvents]) {
    await db.delete(table)
  }
})

describe('the power-sites reader', () => {
  it('seeds the hand-read rows once, with the export’s ids', async () => {
    expect(await seedHandTies(db)).toBe(HAND.length)
    expect(await seedHandTies(db)).toBe(0)
    const stored = await currentTies(db)
    expect(stored).toHaveLength(HAND.length)
    expect(stored.every((r) => r.basis === 'hand' && r.ended_at === null)).toBe(true)
    // The id the export has always served for a row: site, role, company, page and quote.
    const nypa = stored.find((r) => r.company_name === 'New York Power Authority')!
    expect(nypa.id).toBe(
      contentHash({
        site: SITE,
        role: 'utility',
        company: 'New York Power Authority',
        source_url: nypa.source_url,
        quote: nypa.quote,
      }),
    )
    // A grid row takes the form and filing date of the link on the same page.
    const grid = stored.find((r) => r.site === SITE && r.role === 'grid')!
    expect(grid).toMatchObject({ form: '10-Q', filed: '2026-11-06' })
    const data = await queryPowerSites(db)
    expect(data.sites.find((s) => s.name === SITE)?.links).toHaveLength(3)
  })

  it('finds a new filing naming a site, offers it to the judge, and keeps only what the filing says', async () => {
    const before = await (async () => {
      await seedHandTies(db)
      return powerTiesStamp(db)
    })()
    const report = await runPowerSiteReads(db, { raw: rawStore, fetcher, now: NOW, slots: 1 })
    expect(report.searched).toContain(SITE)
    expect(report.read).toEqual([
      { site: SITE, document_id: DOC_ID, form: '10-Q', status: 'read', excerpts: 1 },
    ])
    // The 500 MW sentence and the grid are repeated word for word: restamped to the new filing.
    expect(report.restamped).toBe(2)
    const restamped = (await currentTies(db, SITE)).find((r) => r.mw === 500)!
    expect(restamped).toMatchObject({
      source_url: NEW_10Q_URL,
      accession_no: NEW_10Q,
      published: '2027-05-07',
      source_title: 'TERAWULF INC. Form 10-Q, filed 2027-05-07',
      basis: 'hand',
    })
    // Read once: the next run fetches nothing new.
    const again = await runPowerSiteReads(db, { raw: rawStore, fetcher, now: NOW, slots: 1 })
    expect(again.read).toEqual([])

    // Waiting for the judge: the site's gap would say so, if it had none.
    const [offered] = await powerSiteReview(db, readRaw)
    expect(offered).toMatchObject({
      document_id: DOC_ID,
      site: SITE,
      site_names: ['Lake Mariner'],
      labs: ['anthropic'],
      form: '10-Q',
    })
    expect(offered!.known.length).toBe(4)
    expect(offered!.excerpts.join(' ')).toContain('National Grid')

    const result = await applyPowerSiteReadings(
      db,
      readRaw,
      [
        {
          document_id: DOC_ID,
          site: SITE,
          ties: [
            {
              role: 'utility',
              company: 'National Grid',
              mw: 250,
              mw_meaning: 'Additional electric service agreed in March 2027',
              quote:
                'In March 2027, National Grid agreed to provide electric service of an additional 250 MW to the Lake Mariner Data Campus through a new 345 kV substation.',
            },
            // A figure the quote doesn't write is dropped.
            {
              role: 'utility',
              company: 'National Grid',
              mw: 345,
              mw_meaning: 'Substation',
              quote:
                'National Grid agreed to provide electric service of an additional 250 MW to the Lake Mariner Data Campus',
            },
            // So is a company the quote doesn't name.
            {
              role: 'host',
              company: 'Fluidstack',
              mw: null,
              mw_meaning: null,
              quote:
                'The Lake Mariner Data Campus sources power from the NYISO Zone A grid, which is characterized by low-cost, low-carbon energy.',
            },
          ],
        },
      ],
      NOW,
    )
    expect(result).toMatchObject({ accepted: 1, settled: 1, ended: 1 })
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'mw-not-in-quote',
      'company-not-in-quote',
    ])

    const current = await currentTies(db, SITE)
    expect(current.find((r) => r.basis === 'judge')).toMatchObject({
      role: 'utility',
      company_name: 'National Grid',
      ticker: null,
      unlisted: 'not matched to a listing',
      mw: 250,
      accession_no: NEW_10Q,
      form: '10-Q',
      published: '2027-05-07',
      source_url: NEW_10Q_URL,
      fetched_at: NOW.toISOString(),
    })
    // The NYPA sentence the new 10-Q no longer has has ended; the 10-K's 378 MW lease has not.
    const ended = (await db.select().from(schema.powerSiteTies)).filter((r) => r.ended_at)
    expect(ended.map((r) => r.company_name)).toEqual(['New York Power Authority'])
    expect(ended[0]!.ended_by).toBe(NEW_10Q)
    expect(current.some((r) => r.mw === 378)).toBe(true)

    // Settled: offered no more, and the cache key moved.
    expect(await powerSiteReview(db, readRaw)).toEqual([])
    expect(await powerTiesStamp(db)).not.toBe(before)
    const late = await applyPowerSiteReadings(
      db,
      readRaw,
      [{ document_id: DOC_ID, site: SITE, ties: [] }],
      NOW,
    )
    expect(late.rejected.map((r) => r.reason)).toEqual(['not-offered'])

    const data = await queryPowerSites(db)
    const site = data.sites.find((s) => s.name === SITE)!
    expect(site.links.map((l) => l.company).sort()).toEqual([
      'National Grid',
      'TeraWulf',
      'TeraWulf',
    ])
    expect(site.links.find((l) => l.company === 'National Grid')!.basis).toBe('judge')
  })

  it('names each lab site with no power row in the table’s gaps', async () => {
    await seedHandTies(db)
    const data = await queryPowerSites(db)
    const sites = await epochLabSites(db)
    const covered = new Set(data.sites.map((s) => s.name))
    const uncovered = sites.filter((s) => !covered.has(s.name)).map((s) => s.name)
    expect(uncovered.length).toBeGreaterThan(0)
    expect(data.uncovered.map((u) => u.name).sort()).toEqual([...uncovered].sort())
    const siteGaps = data.gaps.filter((g) => g.site !== null)
    expect(siteGaps.map((g) => g.site).sort()).toEqual([...uncovered].sort())
    const colossus = data.gaps.find((g) => g.site === 'Colossus 2')!
    expect(colossus).toMatchObject({ id: 'site:Colossus 2' })
    expect(colossus.title).toContain('Colossus 2')
    expect(colossus.reason).toContain('MW')
    // Beside them, what the table never reads.
    expect(data.gaps.some((g) => g.site === null)).toBe(true)
  })
})

describe('the weekly re-read', () => {
  const AEP = 'https://www.aep.com/news/releases/read/9883'
  const APS = 'https://www.aps.com/runway'
  const aep = HAND.find((r) => r.source_url === AEP)!

  it('restamps a quote still on its page and flags one that is gone; never re-reads a filing', async () => {
    await seedHandTies(db)
    const asked: string[] = []
    const pages: SourceFetcher = async (s) => {
      asked.push(s.url)
      if (s.url === AEP)
        return ok(`<html><body><p>${aep.quote.replace('&', '&amp;')}</p></body></html>`)
      if (s.url === APS)
        return ok('<html><body><p>The Runway project is complete.</p></body></html>')
      if (s.url.startsWith('https://www.williams.com/'))
        return { ok: false, status: 404, detail: 'HTTP 404' }
      return { ok: false, status: 403, detail: 'HTTP 403' }
    }
    const report = await verifyHandTies(db, { fetcher: pages, now: NOW })
    expect(asked.some((u) => u.includes('sec.gov'))).toBe(false)
    // One fetch per page, however many rows cite it.
    expect(new Set(asked).size).toBe(asked.length)
    const status = (url: string) =>
      report.checks.filter((c) => c.source_url === url).map((c) => c.status)
    expect(status(AEP)).toEqual(['found'])
    expect(status(APS)).toEqual(['gone'])
    expect(
      report.checks.find((c) => c.source_url.startsWith('https://www.williams.com/'))!.status,
    ).toBe('gone')
    expect(report.checks.filter((c) => c.status === 'unread').length).toBeGreaterThan(0)

    const stored = await currentTies(db)
    expect(stored.find((r) => r.source_url === AEP)!.fetched_at).toBe(NOW.toISOString())
    // A gone quote keeps the date it was last seen, and nothing ends.
    expect(stored.find((r) => r.source_url === APS)!.fetched_at).toBe('2026-11-20T01:14:16.594Z')
    expect(stored).toHaveLength(HAND.length)
    const events = await db.select().from(schema.opsEvents)
    expect(events.map((e) => e.kind)).toEqual(['power_quote_gone', 'power_quote_gone'])
    expect(events.some((e) => e.detail?.includes('Microsoft Goodyear'))).toBe(true)
  })
})

describe('the checks', () => {
  const text =
    'In March 2027, National Grid agreed to provide electric service of an additional 250 MW to the Lake Mariner Data Campus. Lake Mariner is a 1.2 gigawatt campus hosted by TeraWulf.'
  const terms = ['Lake Mariner']

  it('finds megawatts only where the quote writes them', () => {
    expect(mwWritten('an additional 250 MW to', 250)).toBe(true)
    expect(mwWritten('a 1.2 gigawatt campus', 1200)).toBe(true)
    expect(mwWritten('1,400 megawatts of new load', 1400)).toBe(true)
    expect(mwWritten('a 345 kV substation', 345)).toBe(false)
    expect(mwWritten('250 MW', 25)).toBe(false)
  })

  it('holds a tie to the document, the company, the site and its role', () => {
    const base = { mw: null, mw_meaning: null }
    const quote =
      'National Grid agreed to provide electric service of an additional 250 MW to the Lake Mariner Data Campus.'
    expect(
      checkTie({ ...base, role: 'utility', company: 'National Grid', quote }, text, terms),
    ).toBeNull()
    expect(
      checkTie(
        { ...base, role: 'utility', company: 'National Grid', quote: `${quote} It is great.` },
        text,
        terms,
      )?.reason,
    ).toBe('quote-not-in-document')
    expect(
      checkTie(
        {
          ...base,
          role: 'utility',
          company: 'National Grid',
          quote: 'In March 2027, National Grid agreed to provide electric service of an additional',
        },
        text,
        terms,
      )?.reason,
    ).toBe('site-not-in-quote')
    expect(
      checkTie({ ...base, role: 'equipment', company: 'National Grid', quote }, text, terms)
        ?.reason,
    ).toBe('role-not-in-quote')
    expect(
      checkTie(
        { role: 'utility', company: 'National Grid', mw: 250, mw_meaning: null, quote },
        text,
        terms,
      )?.reason,
    ).toBe('mw-without-meaning')
    expect(roleStated('Lake Mariner is a 1.2 gigawatt campus hosted by TeraWulf.', 'host')).toBe(
      true,
    )
  })

  it('matches a company to a listing only from the hand-read table or the filer', () => {
    const filer = 'TERAWULF INC.  (WULF)  (CIK 0001083301)'
    expect(listingOf('We Energies', filer)).toMatchObject({
      parent: 'WEC Energy Group',
      ticker: 'WEC',
    })
    expect(listingOf('TeraWulf', filer)).toMatchObject({ ticker: 'WULF', unlisted: null })
    expect(listingOf('National Grid', filer)).toMatchObject({ ticker: null })
    expect(filerOf(filer)).toEqual({ name: 'TERAWULF INC.', ticker: 'WULF' })
    expect(filerOf('SB Energy Global Holdings, Inc.  (CIK 0002133037)')).toEqual({
      name: 'SB Energy Global Holdings, Inc.',
      ticker: null,
    })
  })

  it('reads a full-text search answer: main documents and press releases, newest first', () => {
    const docs = searchHits(SEARCH)
    expect(docs.map((d) => d.document_id)).toEqual([DOC_ID])
    expect(docs[0]!.url).toBe(NEW_10Q_URL)
    expect(() => searchHits('{"error":"bad"}')).toThrow()
  })

  it('searches each site by the names filings use, or a best guess from Epoch’s name', () => {
    expect(searchQuery(searchFor({ name: SITE, owner: '', users: '' })!)).toBe('"Lake Mariner"')
    expect(
      searchQuery(
        searchFor({ name: 'Meta Temple', owner: 'Meta #confident', users: 'Meta #confident' })!,
      ),
    ).toBe('("Temple") "data center"')
    expect(searchFor({ name: 'Meta Abc', owner: 'Meta #confident', users: '' })).toBeNull()
    const url = searchUrl({ terms: ['Lake Mariner'], with: null }, '2026-11-19', '2027-05-08')
    expect(url).toContain('dateRange=custom&startdt=2026-11-19&enddt=2027-05-08')
    expect(url).toContain('forms=10-K,10-Q,8-K')
  })

  it('spreads the sites over the day’s four runs, each once', () => {
    const sites = ['A', 'B', 'C', 'D', 'E'].map((name) => ({
      name,
      labs: [],
      owner: '',
      users: '',
      country: '',
      mw_now: 1,
    }))
    const runs = [0, 6, 12, 18].map((h) =>
      sitesDue(sites, new Date(`2027-05-08T${String(h).padStart(2, '0')}:47:00Z`)).map(
        (s) => s.name,
      ),
    )
    expect(runs.flat().sort()).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('cuts excerpts around the site’s names, only where they speak of power', () => {
    const doc = `${'filler '.repeat(300)}Lake Mariner hosts our offices. ${'filler '.repeat(300)}The Lake Mariner campus draws 250 MW. ${'filler '.repeat(300)}`
    const runs = powerExcerpts(doc, terms)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toContain('250 MW')
    expect(doc.includes(runs[0]!)).toBe(true)
  })

  it('takes a hand-read filing’s form from its title, and none for an exhibit or a page off EDGAR', () => {
    expect(
      formOf(
        'https://www.sec.gov/Archives/edgar/data/1083301/000162828026071671/wulf-20260930.htm',
        'TeraWulf Inc. Form 10-Q for the quarter ended September 30, 2026',
      ),
    ).toBe('10-Q')
    expect(
      formOf(
        'https://www.sec.gov/Archives/edgar/data/936340/000093634026000051/exhibit991-123125.htm',
        'DTE Energy 2025 results press release (Exhibit 99.1 to Form 8-K)',
      ),
    ).toBeNull()
    expect(formOf('https://www.aps.com/runway', 'Runway 230kV')).toBeNull()
  })
})
