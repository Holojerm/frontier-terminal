// How a stored value READS. Every timestamp is ISO 8601 with a timezone and
// every price is the vendor's number; nothing here reformats data at rest,
// it only decides the reading form and keeps the exact value one hover away.
//
// SSR note: a relative label needs a clock, and the server's clock is not
// the reader's. Components pass `now = null` on the server and set it after
// mount (layers/terminal/app/composables/useNow.ts), so first paint is the absolute form and
// a hydration mismatch on a provenance stamp cannot happen.
//
// The reader's zone is the same story. Page HTML is cached and shared, so the
// server always reads in UTC_STYLE, and the reader's StampStyle
// (layers/terminal/app/composables/useReaderPrefs.ts) applies after hydration.
// Only a reading with a time of day moves with the zone. A date printed alone
// (a filing period, a UTC-day chart bucket, a first-seen day) is a UTC date
// and prints as stored, so a day never shifts under a reader near midnight.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const pad = (n: number) => String(n).padStart(2, '0')

/** How an instant reads: which zone, which clock, which date form, and whether ages are relative. */
export interface StampStyle {
  /** An IANA zone. 'UTC' keeps the 'Z' suffix the site has always printed. */
  zone: string
  hour12: boolean
  /** '2026-08-25' instead of 'Aug 25'. */
  iso: boolean
  /** '3h ago' inside a day; off, every stamp is absolute. */
  relative: boolean
}

/** The server's reading, and every reader's until their settings load. */
export const UTC_STYLE: StampStyle = { zone: 'UTC', hour12: false, iso: false, relative: true }

interface Wall {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  /** 'EDT', 'GMT+1'; null for UTC, which prints as 'Z'. */
  zone: string | null
}

// Intl formatters are costly to build and a page formats hundreds of stamps.
const formatters = new Map<string, Intl.DateTimeFormat>()

function wallClock(d: Date, zone: string): Wall {
  if (zone === 'UTC') {
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth(),
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      zone: null,
    }
  }
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
      timeZoneName: 'short',
    })
    formatters.set(zone, f)
  }
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {}
  for (const p of f.formatToParts(d)) parts[p.type] = p.value
  return {
    year: Number(parts.year),
    month: Number(parts.month) - 1,
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    zone: parts.timeZoneName ?? zone,
  }
}

/** True when the zone is one this runtime can read in. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function dateOf(w: Wall, nowYear: number, style: StampStyle): string {
  if (style.iso) return `${w.year}-${pad(w.month + 1)}-${pad(w.day)}`
  const year = w.year === nowYear ? '' : ` ${w.year}`
  return `${MONTHS[w.month]} ${w.day}${year}`
}

function timeOf(w: Wall, style: StampStyle): string {
  const clock = style.hour12
    ? `${w.hour % 12 || 12}:${pad(w.minute)} ${w.hour < 12 ? 'AM' : 'PM'}`
    : `${pad(w.hour)}:${pad(w.minute)}`
  if (w.zone !== null) return `${clock} ${w.zone}`
  return style.hour12 ? `${clock} UTC` : `${clock}Z`
}

/** 'Aug 25 23:08Z' — same-year absolute; adds the year when it differs. */
export function absoluteStamp(
  iso: string,
  now: number | null = null,
  style: StampStyle = UTC_STYLE,
): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const w = wallClock(d, style.zone)
  const nowYear = now === null ? w.year : wallClock(new Date(now), style.zone).year
  return `${dateOf(w, nowYear, style)} ${timeOf(w, style)}`
}

/**
 * Reading form: relative inside a day ("3h ago"), absolute beyond it.
 * `now === null` (server render, or an unparseable value) always yields the
 * absolute form; a stamp ahead of the clock is never guessed at either.
 */
export function relativeStamp(
  iso: string,
  now: number | null,
  style: StampStyle = UTC_STYLE,
): string {
  const t = new Date(iso).getTime()
  if (now === null || Number.isNaN(t) || !style.relative) return absoluteStamp(iso, now, style)
  const delta = now - t
  if (delta < 0) return absoluteStamp(iso, now, style)
  if (delta < MINUTE) return 'just now'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`
  return absoluteStamp(iso, now, style)
}

/** 'UTC', or the zone as a reader names it: 'America/New York'. */
export function zoneName(style: StampStyle): string {
  return style.zone === 'UTC' ? 'UTC' : style.zone.replaceAll('_', ' ')
}

/** Tooltip text: the exact stored value, never abbreviated. */
export function exactStamp(iso: string): string {
  return iso
}

/** 'boards-api.greenhouse.io' from a URL; the input itself if unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * $/Mtok as printed: '$2.00', '$0.075', '—' for absent.
 *
 * Two decimals is the default, but never at the cost of a digit the vendor
 * published: a flat toFixed(2) turns Gemini's $0.075 into "$0.07" — a price
 * quoted 7% below the source cited beside it. Values carrying more precision
 * keep it.
 */
export function money(v: number | null): string {
  if (v === null) return '—'
  const abs = Math.abs(v)
  if (abs !== 0 && abs < 0.01) return `$${v}`
  const wholeCents = Math.abs(v * 100 - Math.round(v * 100)) < 1e-9
  return wholeCents ? `$${v.toFixed(2)}` : `$${Number(v.toFixed(4))}`
}

/** Signed percent change, or null when either side is missing or the base is zero. */
export function pctChange(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before === 0) return null
  return ((after - before) / before) * 100
}

/** '+25%' / '−12%' / '0%' — a sign the reader can see, not a color. */
export function pctLabel(pct: number): string {
  const rounded = Math.round(pct * 10) / 10
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : ''
  return `${sign}${Math.abs(rounded)}%`
}

/** '+12' / '−3' / '±0' — a signed count, the sign always visible (U+2212 for minus). */
export function signed(n: number): string {
  return n > 0 ? `+${count(n)}` : n < 0 ? `−${count(Math.abs(n))}` : '±0'
}

/** '1,234' — grouped integer for counts. */
export function count(n: number): string {
  return n.toLocaleString('en-US')
}

const UNITS: readonly (readonly [number, string])[] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
]

/**
 * A non-negative magnitude as three significant figures and a unit, or null
 * below a thousand. The digits are chosen after rounding, so 999.6M reads
 * '1.00B' rather than '1000M', and 99.96M '100M' rather than '100.0M'.
 */
function compactMagnitude(abs: number): string | null {
  for (let i = 0; i < UNITS.length; i++) {
    const [value, unit] = UNITS[i]!
    if (abs < value) continue
    const x = abs / value
    const digits = Math.round(x * 10) / 10 >= 100 ? 0 : Math.round(x * 100) / 100 >= 10 ? 1 : 2
    const text = x.toFixed(digits)
    if (Number(text) >= 1000 && i > 0) {
      const [upValue, upUnit] = UNITS[i - 1]!
      return `${(abs / upValue).toFixed(2)}${upUnit}`
    }
    return `${text}${unit}`
  }
  return abs >= 999.5 ? '1.00K' : null
}

/** '2.4T' / '910B' / '15.0M' — token counts at the scale a chart axis can carry. */
export function compactTokens(n: number): string {
  const text = compactMagnitude(Math.abs(n))
  return text === null ? String(n) : `${n < 0 ? '-' : ''}${text}`
}

/** '12.3%' from a 0..1 share; '—' for absent. */
export function sharePct(share: number | null): string {
  return share === null ? '—' : `${(share * 100).toFixed(1)}%`
}

/** '+1.2 pp' / '−0.4 pp' / '0.0 pp' — a share change in percentage points, sign visible. */
export function ppLabel(pp: number): string {
  const rounded = Math.round(pp * 10) / 10
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : ''
  return `${sign}${Math.abs(rounded).toFixed(1)} pp`
}

/** '$7.81B' / '$412M' / '$20.9M' / '$676K' — a dollar figure at the scale a card can carry; the exact value stays in the markup. */
export function compactUsd(n: number): string {
  const sign = n < 0 ? '−' : ''
  const abs = Math.abs(n)
  return `${sign}$${compactMagnitude(abs) ?? abs.toFixed(0)}`
}

/** '1 Apr → 30 Jun 2026' style period label from two ISO dates, with the span named. */
export function periodLabel(days: number): string {
  if (days >= 350) return 'year'
  if (days >= 260) return 'nine months'
  if (days >= 170) return 'half'
  if (days >= 80) return 'quarter'
  return `${days} days`
}
