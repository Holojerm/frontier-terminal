// Grid load where the lab sites are (GET /api/grid-load, the /power page):
// EIA-930 demand per balancing authority holding a tracked site, as monthly
// and weekly averages with their change on a year before, and ERCOT's own
// count of the large loads it has let energize. A load reading, not a
// measure of how busy any data center is: an authority's demand moves with
// weather, the economy and every other customer, and nothing here separates
// the sites' share of it.

export interface GridArea {
  /** EIA-930's respondent code. */
  ba: string
  /** EIA's name for the authority. */
  name: string
  /** What the page calls it. */
  short: string
  /**
   * The clock EIA keeps the authority's local days on: its API's timezone facet,
   * and the IANA zone that counts each day's hours. Checked against the six-month
   * files' daily sums on 2026-11-21.
   */
  zone: { eia: 'Eastern' | 'Central' | 'Arizona'; iana: string }
}

const EASTERN = { eia: 'Eastern', iana: 'America/New_York' } as const
const CENTRAL = { eia: 'Central', iana: 'America/Chicago' } as const
// EIA keeps El Paso Electric on standard time all year, like Arizona.
const ARIZONA = { eia: 'Arizona', iana: 'America/Phoenix' } as const

/** The authorities stored: every one a tracked lab site sits in or is likely to. */
export const GRID_AREAS: readonly GridArea[] = [
  {
    ba: 'ERCO',
    name: 'Electric Reliability Council of Texas, Inc.',
    short: 'ERCOT',
    zone: CENTRAL,
  },
  { ba: 'PJM', name: 'PJM Interconnection, LLC', short: 'PJM', zone: EASTERN },
  {
    ba: 'MISO',
    name: 'Midcontinent Independent System Operator, Inc.',
    short: 'MISO',
    zone: CENTRAL,
  },
  { ba: 'NYIS', name: 'New York Independent System Operator', short: 'NYISO', zone: EASTERN },
  { ba: 'AZPS', name: 'Arizona Public Service Company', short: 'APS (Arizona)', zone: ARIZONA },
  {
    ba: 'SOCO',
    name: 'Southern Company Services, Inc. - Trans',
    short: 'Southern Company',
    zone: CENTRAL,
  },
  { ba: 'TVA', name: 'Tennessee Valley Authority', short: 'TVA', zone: CENTRAL },
  { ba: 'EPE', name: 'El Paso Electric Company', short: 'El Paso Electric', zone: ARIZONA },
]

export const GRID_AREA_CODES: ReadonlySet<string> = new Set(GRID_AREAS.map((a) => a.ba))

/** A grid operator as a page names it (power_site_ties role grid) → its EIA-930 code. */
export const GRID_NAME_TO_BA: Readonly<Record<string, string>> = {
  ERCOT: 'ERCO',
  'Electric Reliability Council of Texas': 'ERCO',
  NYISO: 'NYIS',
  PJM: 'PJM',
  MISO: 'MISO',
  TVA: 'TVA',
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** 'Sep 2026' for 2026-09 or 2026-09-01. */
export function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
}

// ─── Derived series ──────────────────────────────────────────────────────────

export interface GridDayRow {
  date: string
  mwh: number
  hours: number
}

export interface GridMonth {
  /** YYYY-MM */
  month: string
  /** Average load over the month's reported hours. */
  avg_mw: number
  /** Against the same month a year before; null when either month is short. */
  yoy: number | null
  /** Reported hours as a share of the month's hours. */
  coverage: number
}

export interface GridWeek {
  /** The Monday, YYYY-MM-DD. */
  week: string
  avg_mw: number
  /** Against the week 52 weeks before; null when either week is short. */
  yoy: number | null
}

/** A month or week counts as whole at this share of its hours reported. */
export const GRID_COVERAGE_FLOOR = 0.97

const daysIn = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

const shiftYear = (month: string) => `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`

/** Monthly averages, oldest first. The newest month is left out until it is whole. */
export function gridMonths(days: readonly GridDayRow[]): GridMonth[] {
  const by = new Map<string, { mwh: number; hours: number }>()
  for (const d of days) {
    const k = d.date.slice(0, 7)
    const m = by.get(k) ?? { mwh: 0, hours: 0 }
    m.mwh += d.mwh
    m.hours += d.hours
    by.set(k, m)
  }
  const months = [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, m]) => ({
      month,
      avg_mw: m.mwh / m.hours,
      coverage: Math.min(1, m.hours / (daysIn(month) * 24)),
    }))
  const whole = new Map(
    months.filter((m) => m.coverage >= GRID_COVERAGE_FLOOR).map((m) => [m.month, m]),
  )
  return months
    .filter((m) => m.coverage >= GRID_COVERAGE_FLOOR)
    .map((m) => {
      const before = whole.get(shiftYear(m.month))
      return { ...m, yoy: before ? m.avg_mw / before.avg_mw - 1 : null }
    })
}

const mondayOf = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

const daysBefore = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)

/** Weekly averages, Monday to Sunday, oldest first; only whole weeks. */
export function gridWeeks(days: readonly GridDayRow[]): GridWeek[] {
  const by = new Map<string, { mwh: number; hours: number; n: number }>()
  for (const d of days) {
    const k = mondayOf(d.date)
    const w = by.get(k) ?? { mwh: 0, hours: 0, n: 0 }
    w.mwh += d.mwh
    w.hours += d.hours
    w.n++
    by.set(k, w)
  }
  const whole = new Map(
    [...by.entries()]
      .filter(([, w]) => w.n === 7 && w.hours >= 7 * 24 * GRID_COVERAGE_FLOOR)
      .map(([week, w]) => [week, w.mwh / w.hours]),
  )
  return [...whole.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, avg]) => {
      const before = whole.get(daysBefore(week, 364))
      return { week, avg_mw: avg, yoy: before === undefined ? null : avg / before - 1 }
    })
}

// ─── The payload ─────────────────────────────────────────────────────────────

export interface GridSiteLink {
  /** Epoch's name for the site. */
  site: string
  labs: LabId[]
  mw_now: number
  /**
   * grid: a page names the site's grid operator (quote and source_url are its).
   * utility: the site's utility, as a page ties it, is in this authority per
   * EIA-861 (quote is EIA-861's row, source_url its file).
   */
  basis: 'grid' | 'utility'
  /** The utility on a utility row; the grid operator as the page names it on a grid row. */
  via: string
  quote: string
  source_url: string
  fetched_at: string
}

export interface GridTicker {
  ticker: string
  company: string
  /** Its roles at the sites in this authority (utility, generation, equipment, host). */
  roles: string[]
  sites: string[]
}

export interface GridAreaReading extends GridArea {
  sites: GridSiteLink[]
  /** Listed companies tied to those sites (power_site_ties), with their roles there. */
  tickers: GridTicker[]
  monthly: GridMonth[]
  /** The newest two years of whole weeks. */
  weekly: GridWeek[]
  /** The newest whole month. */
  latest: GridMonth | null
  /** The newest file the days were read from. */
  source: { source_url: string; fetched_at: string } | null
}

export interface ErcotLargeLoadFact {
  period: string
  value_mw: number
  qualifier: string | null
  horizon: string | null
  quote: string
  /** The report and when ERCOT posted it. */
  source_url: string
  posted: string
  fetched_at: string
}

export interface ErcotMonth {
  /** YYYY-MM */
  period: string
  /** Approved to energize, as of the report. */
  approved_mw: number | null
  /** The sum of each approved load's own peak in the month (non-simultaneous). */
  observed_peak_mw: number | null
  /** Reports that state this month, newest first; the figures are the newest's. */
  vintages: number
  quote: string
  source_url: string
  posted: string
  fetched_at: string
}

export interface ErcotLargeLoads {
  /** One row per month, from the newest report that states it, oldest first. */
  months: ErcotMonth[]
  /** The large-load interconnection queue where a report states its size, newest first. */
  queue: ErcotLargeLoadFact[]
  /** All-time observed energized large load, where a report states it, newest first. */
  energized: ErcotLargeLoadFact[]
  reports: number
}

export interface GridLoadGap {
  id: string
  site: string | null
  title: string
  reason: string
}

export interface GridLoadData {
  as_of: string | null
  areas: GridAreaReading[]
  ercot: ErcotLargeLoads
  /** Lab sites no page we read places in an authority, largest first. */
  unplaced: { site: string; labs: LabId[]; mw_now: number }[]
  gaps: GridLoadGap[]
  caveat: string
}

export const GRID_LOAD_CAVEAT =
  'A load reading, not a measure of how busy any data center is: an authority’s demand moves with weather, the economy and every other customer it serves, and nothing here separates the sites’ share of it. ERCOT’s observed figure is the sum of each approved large load’s own monthly peak, not their combined draw at any one time.'
