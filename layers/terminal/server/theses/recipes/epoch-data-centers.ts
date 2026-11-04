// Epoch AI's AI data centers dataset (CC BY 4.0): power, H100-equivalents
// and capital cost per site, estimated from satellite imagery, permits and
// filings. Two files: the sites as they stand now, with owner and users,
// and each site's timeline of dated estimates, planned dates included.
//
// The estimates are Epoch's: 80% of power estimates fall within a factor of
// 1.4, compute is mostly derived from power, and coverage starts with sites
// operational in 2024 or later. Owner and Users differ (Colossus is owned by
// SpaceXAI and used by Anthropic), and each name carries Epoch's confidence
// tag, so both are kept verbatim; a signal attributes by Users at #confident
// or #likely (docs/source-audit.md, 2026-11-04).

import type { Observation, Recipe } from './contract'
import { parseCsv } from './csv'

const LICENSE =
  "CC BY 4.0. Epoch AI, 'AI data centers'. Published online at epoch.ai. Retrieved from 'https://epoch.ai/data/ai-data-centers'"

function num(v: string | undefined, field: string): number | null {
  if (v === undefined) throw new Error(`no ${field} column`)
  if (v.trim() === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${field} is not a number: ${v}`)
  return n
}

function column(row: Record<string, string>, field: string): string {
  const v = row[field]
  if (v === undefined) throw new Error(`no ${field} column`)
  return v
}

/** One observation per site: its current power, dated the run (a current state, not a series). */
export function extractSites(body: string, ctx: { date: string }): Observation[] {
  return parseCsv(body).map((r) => ({
    key: column(r, 'Name'),
    date: ctx.date,
    value: num(r['Current power (MW)'], 'Current power (MW)'),
    payload: {
      h100e: num(r['Current H100 equivalents'], 'Current H100 equivalents'),
      capital_cost_busd: num(
        r['Current total capital cost (2025 USD billions)'],
        'Current total capital cost (2025 USD billions)',
      ),
      owner: column(r, 'Owner'),
      users: column(r, 'Users'),
      project: column(r, 'Project'),
      country: column(r, 'Country'),
      chips: column(r, 'Current chip types'),
    },
  }))
}

/** One observation per site and dated estimate; dates after the run are Epoch's projections. */
export function extractTimelines(body: string, ctx: { date: string }): Observation[] {
  return parseCsv(body).map((r) => {
    const date = column(r, 'Date')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`timeline date not ISO: ${date}`)
    return {
      key: column(r, 'Data center'),
      date,
      value: num(r['Power (MW)'], 'Power (MW)'),
      payload: {
        it_power_mw: num(r['IT power (MW)'], 'IT power (MW)'),
        h100e: num(r['H100 equivalents'], 'H100 equivalents'),
        buildings_operational: num(r['Buildings operational'], 'Buildings operational'),
        capital_cost_busd: num(
          r['Total capital cost (2025 USD billions)'],
          'Total capital cost (2025 USD billions)',
        ),
        status: column(r, 'Construction status').trim(),
        projected: date > ctx.date,
      },
    }
  })
}

export const EPOCH_DATA_CENTERS: Recipe = {
  id: 'epoch-data-centers',
  company: 'frontier-labs',
  description: 'Epoch AI data centers: current power, H100e, owner and users per site',
  url: () => 'https://epoch.ai/data/data_centers/data_centers.csv',
  ext: 'csv',
  extract: extractSites,
  license: LICENSE,
}

export const EPOCH_DATA_CENTER_TIMELINES: Recipe = {
  id: 'epoch-data-center-timelines',
  company: 'frontier-labs',
  description:
    'Epoch AI data centers: dated power and H100e estimates per site, planned dates included',
  url: () => 'https://epoch.ai/data/data_centers/data_center_timelines.csv',
  ext: 'csv',
  extract: extractTimelines,
  license: LICENSE,
}
