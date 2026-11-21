// EIA-930's six-month Grid Monitor files, read without the network: which
// file holds a half-year, which halves a run reads, and the line reader that
// keeps the tracked authorities' lines and sums their hours into days. The
// fetch and the store are in grid-load.ts.

import { GRID_AREA_CODES } from '../../shared/utils/grid-load'

export const EIA930_FIRST_PERIOD = '2018H1'
export const BACKFILL_PER_RUN = 4
/** How long after a half closes its file is still re-read. */
export const REVISION_WINDOW_DAYS = 42

const DEMAND_COLUMN = 'Demand (MW) (Adjusted)'

/** 2026H2 → the six-month file EIA publishes for it. */
export function eia930FileUrl(period: string): string {
  const m = /^(\d{4})H([12])$/.exec(period)
  if (!m) throw new Error(`not a half-year: ${period}`)
  const half = m[2] === '1' ? 'Jan_Jun' : 'Jul_Dec'
  return `https://www.eia.gov/electricity/gridmonitor/sixMonthFiles/EIA930_BALANCE_${m[1]}_${half}.csv`
}

export function periodOf(date: Date): string {
  return `${date.getUTCFullYear()}H${date.getUTCMonth() < 6 ? 1 : 2}`
}

/** The UTC instant a half-year ends. */
export function periodEnd(period: string): Date {
  const [y, h] = [Number(period.slice(0, 4)), period.slice(5)]
  return h === '1' ? new Date(Date.UTC(y, 6, 1)) : new Date(Date.UTC(y + 1, 0, 1))
}

/** Every half-year from EIA930_FIRST_PERIOD through the one `now` is in, oldest first. */
export function periodsThrough(now: Date): string[] {
  const out: string[] = []
  const last = periodOf(now)
  for (let y = Number(EIA930_FIRST_PERIOD.slice(0, 4)); ; y++) {
    for (const h of [1, 2]) {
      const p = `${y}H${h}`
      if (p < EIA930_FIRST_PERIOD) continue
      out.push(p)
      if (p === last) return out
    }
  }
}

/** Which halves this run reads: the current one, a recently closed one, then the newest unread. */
export function periodsDue(now: Date, read: ReadonlySet<string>): string[] {
  const all = periodsThrough(now)
  const current = all.at(-1)!
  const due = [current]
  const previous = all.at(-2)
  if (
    previous &&
    now.getTime() - periodEnd(previous).getTime() < REVISION_WINDOW_DAYS * 86_400_000
  ) {
    due.push(previous)
  }
  const unread = all.filter((p) => !read.has(p) && !due.includes(p)).reverse()
  return [...due, ...unread.slice(0, BACKFILL_PER_RUN)]
}

/** One CSV line into fields: quotes are honoured, and a quoted "1,234" keeps its comma. */
export function csvFields(line: string): string[] {
  if (!line.includes('"')) return line.split(',')
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

export interface GridDay {
  ba: string
  date: string
  mwh: number
  hours: number
}

/**
 * Reads a file line by line. `lines` is the header and every kept line,
 * verbatim, joined by \n: the raw bytes stored for the read. Throws on a file
 * whose header lacks the columns it reads, and on one with no kept line.
 */
export class Eia930Reader {
  private header: string[] | null = null
  private col = { ba: -1, date: -1, demand: -1 }
  private readonly kept: string[] = []
  private readonly days = new Map<string, GridDay>()
  private rest = ''

  constructor(private readonly areas: ReadonlySet<string>) {}

  push(text: string): void {
    const parts = (this.rest + text).split('\n')
    this.rest = parts.pop() ?? ''
    for (const line of parts) this.line(line)
  }

  private line(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line) return
    if (!this.header) {
      this.header = csvFields(line).map((h) => h.trim())
      this.col = {
        ba: this.header.indexOf('Balancing Authority'),
        date: this.header.indexOf('Data Date'),
        demand: this.header.indexOf(DEMAND_COLUMN),
      }
      if (Object.values(this.col).some((i) => i < 0)) {
        throw new Error(`EIA-930 header lacks Balancing Authority, Data Date or ${DEMAND_COLUMN}`)
      }
      this.kept.push(line)
      return
    }
    // The authority is the first field; only a tracked one is split.
    const comma = line.indexOf(',')
    const first = line.slice(0, comma).replace(/"/g, '')
    if (!this.areas.has(first)) return
    this.kept.push(line)
    const f = csvFields(line)
    const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(f[this.col.date] ?? '')
    if (!d) throw new Error(`EIA-930 date not MM/DD/YYYY: ${f[this.col.date]}`)
    const v = (f[this.col.demand] ?? '').replace(/,/g, '').trim()
    const date = `${d[3]}-${d[1]}-${d[2]}`
    const key = `${first}|${date}`
    const day = this.days.get(key) ?? { ba: first, date, mwh: 0, hours: 0 }
    if (v !== '') {
      const n = Number(v)
      if (!Number.isFinite(n)) throw new Error(`EIA-930 demand not a number: ${v}`)
      day.mwh += n
      day.hours++
    }
    this.days.set(key, day)
  }

  finish(): { lines: string; days: GridDay[] } {
    if (this.rest) this.line(this.rest)
    this.rest = ''
    if (!this.header) throw new Error('EIA-930 file is empty')
    if (this.kept.length < 2) throw new Error('EIA-930 file has no tracked authority')
    return {
      lines: this.kept.join('\n') + '\n',
      // A day with no hour carrying a value says nothing; it is not a zero.
      days: [...this.days.values()].filter((d) => d.hours > 0),
    }
  }
}

/** A whole file's text through the reader: the tests and the fixture use this. */
export function readEia930(text: string, areas: ReadonlySet<string> = GRID_AREA_CODES) {
  const r = new Eia930Reader(areas)
  r.push(text)
  return r.finish()
}
