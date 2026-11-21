// EIA-930 daily demand from EIA's API v2 (daily-region-data), the primary
// read when NUXT_EIA_API_KEY is set. It is the same series as the six-month
// files (eia930.ts): EIA's daily value for an authority on its own local
// clock equals the file's adjusted hours summed by Data Date, checked for all
// eight authorities on 2026-11-21. The API starts on 2019-01-01, a day ahead
// of the files at the newest end; 2018 still comes from the files.
//
// The key goes in the X-Api-Key header, never the URL, so the stored
// source_url and the R2 copy of each response carry none. A response that
// somehow contains it is refused before it is stored.

import type { GridDay } from './eia930'

export const EIA_API_ORIGIN = 'https://api.eia.gov'
export const EIA_API_FIRST_DAY = '2019-01-01'
/** EIA's cap on rows per request. */
export const EIA_API_PAGE = 5000
/** Days before the newest stored day re-read each run: EIA revises recent hours. */
export const EIA_API_OVERLAP_DAYS = 42

/** The authorities that share one EIA clock, so one request serves them all. */
export function zoneGroups(areas: readonly GridArea[] = GRID_AREAS): Map<string, GridArea[]> {
  const out = new Map<string, GridArea[]>()
  for (const a of areas) out.set(a.zone.eia, [...(out.get(a.zone.eia) ?? []), a])
  return out
}

/** One page of daily demand for some authorities on one clock, oldest first. */
export function eiaDailyUrl(o: {
  bas: readonly string[]
  zone: string
  start: string
  offset: number
}): string {
  const q = new URLSearchParams()
  q.set('frequency', 'daily')
  q.append('data[0]', 'value')
  for (const ba of o.bas) q.append('facets[respondent][]', ba)
  q.append('facets[type][]', 'D')
  q.append('facets[timezone][]', o.zone)
  q.set('start', o.start)
  q.append('sort[0][column]', 'period')
  q.append('sort[0][direction]', 'asc')
  q.set('offset', String(o.offset))
  q.set('length', String(EIA_API_PAGE))
  return `${EIA_API_ORIGIN}/v2/electricity/rto/daily-region-data/data/?${q.toString()}`
}

/** Minutes the zone is ahead of UTC at an instant. */
function offsetMinutes(at: number, iana: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: iana,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(at))
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  return (Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute')) - at) / 60_000
}

/** The UTC instant a local day begins (US clock changes are at 2 a.m., so midnight is never skipped). */
function localMidnight(date: string, iana: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`)
  const first = guess - offsetMinutes(guess, iana) * 60_000
  return guess - offsetMinutes(first, iana) * 60_000
}

/** 24, or 23 and 25 on the days the clock changes. */
export function hoursInLocalDay(date: string, iana: string): number {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  return Math.round((localMidnight(next, iana) - localMidnight(date, iana)) / 3_600_000)
}

export interface EiaPage {
  days: GridDay[]
  total: number
  rows: number
}

/** One response: its rows as days. Throws on a shape it does not recognize. */
export function readEiaDaily(body: string, areas: readonly GridArea[] = GRID_AREAS): EiaPage {
  const parsed = JSON.parse(body) as {
    response?: { total?: string | number; data?: unknown[] }
    error?: unknown
  }
  if (parsed.error !== undefined) throw new Error(`EIA API error: ${String(parsed.error)}`)
  const data = parsed.response?.data
  if (!Array.isArray(data)) throw new Error('EIA API response has no response.data')
  const byBa = new Map(areas.map((a) => [a.ba, a]))
  const days: GridDay[] = []
  for (const raw of data) {
    const r = raw as Record<string, unknown>
    const area = byBa.get(String(r.respondent))
    if (!area) continue
    if (r.type !== 'D') throw new Error(`EIA API row is not demand: ${String(r.type)}`)
    if (r.timezone !== area.zone.eia) {
      throw new Error(
        `EIA API row for ${area.ba} is on ${String(r.timezone)}, not ${area.zone.eia}`,
      )
    }
    const date = String(r.period)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`EIA API period not a day: ${date}`)
    if (r['value-units'] !== undefined && r['value-units'] !== 'megawatthours') {
      throw new Error(`EIA API value not in megawatthours: ${String(r['value-units'])}`)
    }
    if (r.value === null || r.value === undefined || r.value === '') continue
    const mwh = Number(r.value)
    if (!Number.isFinite(mwh)) throw new Error(`EIA API value not a number: ${String(r.value)}`)
    days.push({ ba: area.ba, date, mwh, hours: hoursInLocalDay(date, area.zone.iana) })
  }
  return { days, total: Number(parsed.response?.total ?? 0), rows: data.length }
}
