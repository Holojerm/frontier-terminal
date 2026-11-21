import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import epochTimelines from '~~/fixtures/recipes/epoch-data-center-timelines.csv?raw'
import epochSites from '~~/fixtures/recipes/epoch-data-centers.csv?raw'
import curated from '../server/curated/power-sites.json'
import { handTies, insertTies } from '../server/power/store'
import { parseCsv } from '#layers/core/server/recipes/csv'
import {
  EPOCH_DATA_CENTERS,
  EPOCH_DATA_CENTER_TIMELINES,
} from '../server/recipes/epoch-data-centers'
import { runRecipes } from '#layers/core/server/recipes/run'

// The power-sites view over Epoch's committed fixtures, with a small table of
// our own stored in D1, so the join is tested apart from whatever the
// hand-read file holds.

const NOW = new Date('2026-11-04T12:00:00Z')
const raw = { put: async (key: string, body: string) => void (await env.BLOB.put(key, body)) }
const BODIES: Record<string, string> = {
  [EPOCH_DATA_CENTERS.url(NOW)]: epochSites,
  [EPOCH_DATA_CENTER_TIMELINES.url(NOW)]: epochTimelines,
}
const fetcher: SourceFetcher = async (s) =>
  BODIES[s.url]
    ? { ok: true, status: 200, text: BODIES[s.url]!, bytes: BODIES[s.url]!.length }
    : { ok: false, status: 404, detail: 'HTTP 404' }

const link = (
  over: Partial<CuratedPowerSites['sites'][number]['links'][number]>,
): CuratedPowerSites['sites'][number]['links'][number] => ({
  role: 'utility',
  company: 'Indiana Michigan Power',
  parent: 'American Electric Power',
  ticker: 'AEP',
  unlisted: null,
  mw: null,
  mw_meaning: null,
  source_url: 'https://example.com/a',
  source_title: 'A page',
  publisher: 'Example',
  published: null,
  quote: 'Indiana Michigan Power will serve the New Carlisle campus.',
  fetched_at: '2026-11-19T00:00:00.000Z',
  ...over,
})

const TABLE: CuratedPowerSites = {
  sites: [
    { site: 'Anthropic-Amazon New Carlisle', grid: null, links: [link({})] },
    {
      site: 'Meta Prometheus',
      grid: null,
      links: [
        link({ company: 'AEP Ohio' }),
        // A second link to the same listed company must not count the site twice.
        link({ role: 'generation', company: 'AEP Ohio' }),
        link({ role: 'generation', company: 'Williams', parent: null, ticker: 'WMB' }),
      ],
    },
    // Not a lab's site at #confident or #likely: never shown, whatever we have read.
    { site: 'Amazon Madison Mega Site', grid: null, links: [link({})] },
    // A municipal utility: on the site's row, in no ticker's total.
    {
      site: 'Colossus 1',
      grid: null,
      links: [link({ company: 'MLGW', parent: null, ticker: null, unlisted: 'municipal utility' })],
    },
  ],
}

beforeAll(async () => {
  await runRecipes(db, { raw, fetcher, now: () => NOW }, [
    EPOCH_DATA_CENTERS,
    EPOCH_DATA_CENTER_TIMELINES,
  ])
})

beforeEach(async () => {
  await db.delete(schema.powerSiteTies)
  await insertTies(db, handTies(TABLE))
})

describe('power sites', () => {
  it('joins our companies to Epoch’s lab sites, power now and at the furthest estimate', async () => {
    const d = await queryPowerSites(db)
    expect(d.sites.map((s) => s.name)).toEqual([
      'Anthropic-Amazon New Carlisle',
      'Meta Prometheus',
      'Colossus 1',
    ])
    expect(d.sites[0]).toMatchObject({
      labs: ['anthropic'],
      mw_now: 1037,
      mw_planned: 2310,
      planned_date: '2028-03-17',
    })
    expect(d.source?.source_url).toBe('https://epoch.ai/data/data_centers/data_centers.csv')
  })

  it('lists a site once per listed company', async () => {
    const { tickers, sites } = await queryPowerSites(db)
    const aep = tickers.find((t) => t.ticker === 'AEP')!
    const prometheus = sites.find((s) => s.name === 'Meta Prometheus')!
    expect(aep.company).toBe('American Electric Power')
    expect(aep.sites).toEqual(['Anthropic-Amazon New Carlisle', 'Meta Prometheus'])
    expect(aep.roles).toEqual(['utility', 'generation'])
    expect(aep.labs.sort()).toEqual(['anthropic', 'meta'])
    expect(prometheus.links).toHaveLength(3)
    expect(tickers.find((t) => t.ticker === 'WMB')!.sites).toEqual(['Meta Prometheus'])
    // Most sites first.
    expect(tickers.map((t) => t.ticker)).toEqual(['AEP', 'WMB'])
  })

  it('lists the lab sites we have read nothing for', async () => {
    const { uncovered } = await queryPowerSites(db)
    const names = uncovered.map((u) => u.name)
    expect(names).toContain('OpenAI Stargate Abilene')
    expect(names).not.toContain('Meta Prometheus')
    expect(names).not.toContain('Amazon Madison Mega Site')
  })
})

describe('the hand-read table', () => {
  const table = curatedPowerSites.parse(curated)

  it('names only sites in Epoch’s data, each once', () => {
    const epoch = new Set(parseCsv(epochSites).map((r) => r.Name))
    const names = table.sites.map((s) => s.site)
    expect(names.filter((n) => !epoch.has(n))).toEqual([])
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every company a ticker or the reason it has none', () => {
    const neither = table.sites.flatMap((s) =>
      s.links.filter((l) => (l.ticker === null) === (l.unlisted === null)).map((l) => l.company),
    )
    expect(neither).toEqual([])
  })
})

describe('quote matching', () => {
  it('reads a page as text and ignores what a copy changes', () => {
    const html =
      '<p>I&amp;M will serve the <b>2,200&nbsp;MW</b> campus &#8212; Amazon&rsquo;s largest.</p><script>var x = "campus"</script>'
    const text = comparable(pageText(html))
    expect(text).toContain(comparable('I&M will serve the 2,200 MW campus - Amazon’s largest.'))
    expect(text).not.toContain('varx')
    expect(text).not.toContain(comparable('will serve the 2,300 MW campus'))
  })
})
