// GET /api/grid-load's payload. A site is placed in an authority two ways, and the
// row says which: a page names its grid operator (a grid row of power_site_ties),
// or EIA-861 puts its utility there (curated/grid-areas.json, EIA's 2025 Sales to
// Ultimate Customers file). A site neither places is listed as unplaced.

import { max } from 'drizzle-orm'
import { z } from 'zod'

import * as tables from '#server/db/schema'
import curated from '../curated/grid-areas.json'
import { ercotFactsStored, ercotReportCount } from './ercot-large-loads'
import { gridLoadDays, gridLoadFilesRead } from './grid-load'
import { powerSitesStamp } from './stamp'

const curatedGridAreas = z.object({
  source_url: z.url(),
  file: z.string().min(1),
  columns: z.string().min(1),
  fetched_at: z.iso.datetime(),
  utilities: z.array(
    z.object({
      /** The utility as power_site_ties names it. */
      company: z.string().min(1),
      ba: z.string().min(2),
      /** EIA-861's row for the utility, its columns joined by ", ". */
      row: z.string().min(10),
    }),
  ),
})

export const GRID_AREA_TABLE = curatedGridAreas.parse(curated)

const WEEKS_SHOWN = 104

/** Where each lab site sits, from its ties: a grid row first, else a utility EIA-861 places. */
function placeSites(power: PowerSitesData): {
  placed: Map<string, GridSiteLink[]>
  unplaced: GridLoadData['unplaced']
} {
  const byUtility = new Map(GRID_AREA_TABLE.utilities.map((u) => [u.company, u]))
  const placed = new Map<string, GridSiteLink[]>()
  const unplaced: GridLoadData['unplaced'] = []
  const add = (ba: string, link: GridSiteLink) => {
    const list = placed.get(ba) ?? []
    list.push(link)
    placed.set(ba, list)
  }
  for (const s of power.sites) {
    const site = { site: s.name, labs: s.labs, mw_now: s.mw_now }
    const gridBa = s.grid ? GRID_NAME_TO_BA[s.grid.name] : undefined
    if (s.grid && gridBa) {
      add(gridBa, {
        ...site,
        basis: 'grid',
        via: s.grid.name,
        quote: s.grid.quote,
        source_url: s.grid.source_url,
        fetched_at: s.grid.fetched_at,
      })
      continue
    }
    const utility = s.links
      .filter((l) => l.role === 'utility')
      .map((l) => byUtility.get(l.company))
      .find((u) => u !== undefined)
    if (utility) {
      add(utility.ba, {
        ...site,
        basis: 'utility',
        via: utility.company,
        quote: utility.row,
        source_url: GRID_AREA_TABLE.source_url,
        fetched_at: GRID_AREA_TABLE.fetched_at,
      })
      continue
    }
    unplaced.push(site)
  }
  for (const u of power.uncovered) unplaced.push({ site: u.name, labs: u.labs, mw_now: u.mw_now })
  unplaced.sort((a, b) => b.mw_now - a.mw_now || a.site.localeCompare(b.site))
  return { placed, unplaced }
}

/** The listed companies tied to the sites placed in one authority. */
function areaTickers(power: PowerSitesData, sites: readonly string[]): GridTicker[] {
  const out = new Map<string, GridTicker>()
  for (const s of power.sites) {
    if (!sites.includes(s.name)) continue
    for (const l of s.links) {
      if (!l.ticker) continue
      const t = out.get(l.ticker) ?? {
        ticker: l.ticker,
        company: l.parent ?? l.company,
        roles: [],
        sites: [],
      }
      if (!t.roles.includes(l.role)) t.roles.push(l.role)
      if (!t.sites.includes(s.name)) t.sites.push(s.name)
      out.set(l.ticker, t)
    }
  }
  return [...out.values()].sort((a, b) => a.ticker.localeCompare(b.ticker))
}

type FactRow = Awaited<ReturnType<typeof ercotFactsStored>>[number]

const asFact = (r: FactRow): ErcotLargeLoadFact => ({
  period: r.period,
  value_mw: r.value,
  qualifier: r.qualifier,
  horizon: r.horizon,
  quote: r.quote,
  source_url: r.source_url,
  posted: r.posted,
  fetched_at: r.fetched_at,
})

/** Each month from the newest report that states it; the queue and energized totals as stated. */
export function ercotSeries(rows: readonly FactRow[], reports: number): ErcotLargeLoads {
  const newestFirst = [...rows].sort((a, b) => b.posted.localeCompare(a.posted))
  const months = new Map<string, ErcotMonth>()
  for (const r of newestFirst) {
    if (r.metric !== 'approved_to_energize_mw' && r.metric !== 'observed_peak_mw') continue
    let m = months.get(r.period)
    if (!m) {
      m = {
        period: r.period,
        approved_mw: null,
        observed_peak_mw: null,
        vintages: 0,
        quote: r.quote,
        source_url: r.source_url,
        posted: r.posted,
        fetched_at: r.fetched_at,
      }
      months.set(r.period, m)
    }
    // Only the newest report's figures; older reports count as vintages.
    if (r.source_url === m.source_url) {
      if (r.metric === 'approved_to_energize_mw') m.approved_mw = r.value
      else m.observed_peak_mw = r.value
    }
  }
  for (const m of months.values()) {
    m.vintages = new Set(
      rows
        .filter((r) => r.period === m.period && r.metric === 'observed_peak_mw')
        .map((r) => r.source_url),
    ).size
  }
  return {
    months: [...months.values()].sort((a, b) => a.period.localeCompare(b.period)),
    queue: newestFirst.filter((r) => r.metric === 'queue_mw').map(asFact),
    energized: newestFirst.filter((r) => r.metric === 'observed_energized_mw').map(asFact),
    reports,
  }
}

export async function gridLoadStamp(db: PipelineDb): Promise<string> {
  const [[days], [facts], power] = await Promise.all([
    db.select({ at: max(tables.gridLoadDays.fetched_at) }).from(tables.gridLoadDays),
    db.select({ at: max(tables.ercotLargeLoadFacts.fetched_at) }).from(tables.ercotLargeLoadFacts),
    powerSitesStamp(db),
  ])
  return `${days?.at ?? ''}:${facts?.at ?? ''}:${power}`
}

export async function queryGridLoad(db: PipelineDb): Promise<GridLoadData> {
  const power = await queryPowerSites(db)
  const { placed, unplaced } = placeSites(power)
  const bas = GRID_AREAS.filter((a) => placed.has(a.ba)).map((a) => a.ba)
  const [days, files, facts, reports] = await Promise.all([
    gridLoadDays(db, bas),
    gridLoadFilesRead(db),
    ercotFactsStored(db),
    ercotReportCount(db),
  ])
  const newestFile = files.sort((a, b) => b.period.localeCompare(a.period))[0]
  const areas: GridAreaReading[] = []
  for (const area of GRID_AREAS) {
    const sites = placed.get(area.ba)
    if (!sites) continue
    const mine = days.filter((d) => d.ba === area.ba)
    const monthly = gridMonths(mine)
    const newest = mine.at(-1)
    areas.push({
      ...area,
      sites: sites.sort((a, b) => b.mw_now - a.mw_now),
      tickers: areaTickers(
        power,
        sites.map((s) => s.site),
      ),
      monthly,
      weekly: gridWeeks(mine).slice(-WEEKS_SHOWN),
      latest: monthly.at(-1) ?? null,
      source: newest ? { source_url: newest.source_url, fetched_at: newest.fetched_at } : null,
    })
  }
  const gaps: GridLoadGap[] = unplaced.map((u) => ({
    id: `site:${u.site}`,
    site: u.site,
    title: 'Grid not read yet',
    reason: 'No page we have read names its grid operator or a utility EIA places in one.',
  }))
  if (areas.length > 0 && days.length === 0) {
    gaps.push({
      id: 'eia930-unread',
      site: null,
      title: 'EIA-930 not read yet',
      reason: 'The first read of EIA’s Grid Monitor files has not run.',
    })
  }
  gaps.push({
    id: 'behind-the-meter',
    site: null,
    title: 'Power made on site',
    reason:
      'A plant behind a site’s meter, such as the gas plant beside Meta Prometheus, serves the site without the grid, so it is not in any authority’s demand.',
  })
  const asOf = [newestFile?.read_at, facts[0]?.fetched_at, power.as_of]
    .filter((x): x is string => Boolean(x))
    .sort()
    .at(-1)
  return {
    as_of: asOf ?? null,
    areas,
    ercot: ercotSeries(facts, reports),
    unplaced,
    gaps,
    caveat: GRID_LOAD_CAVEAT,
  }
}
