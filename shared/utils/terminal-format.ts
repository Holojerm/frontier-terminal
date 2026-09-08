// How a stored value READS. Every timestamp is ISO 8601 with a timezone and
// every price is the vendor's number; nothing here reformats data at rest,
// it only decides the reading form and keeps the exact value one hover away.
//
// SSR note: a relative label needs a clock, and the server's clock is not
// the reader's. Components pass `now = null` on the server and set it after
// mount (app/composables/useNow.ts), so first paint is the absolute form and
// a hydration mismatch on a provenance stamp cannot happen.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const pad = (n: number) => String(n).padStart(2, '0')

/** 'Aug 25 23:08Z' — same-year absolute; adds the year when it differs. */
export function absoluteStamp(iso: string, now: number | null = null): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
  const nowYear = now === null ? d.getUTCFullYear() : new Date(now).getUTCFullYear()
  const year = d.getUTCFullYear() === nowYear ? '' : ` ${d.getUTCFullYear()}`
  return `${day}${year} ${time}`
}

/**
 * Reading form: relative inside a day ("3h ago"), absolute beyond it.
 * `now === null` (server render, or an unparseable value) always yields the
 * absolute form; a stamp ahead of the clock is never guessed at either.
 */
export function relativeStamp(iso: string, now: number | null): string {
  const t = new Date(iso).getTime()
  if (now === null || Number.isNaN(t)) return absoluteStamp(iso, now)
  const delta = now - t
  if (delta < 0) return absoluteStamp(iso, now)
  if (delta < MINUTE) return 'just now'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`
  return absoluteStamp(iso, now)
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

/** '1,234' — grouped integer for counts. */
export function count(n: number): string {
  return n.toLocaleString('en-US')
}

/** '2.4T' / '910B' / '15.0M' — token counts at the scale a chart axis can carry. */
export function compactTokens(n: number): string {
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [value, unit] of units) {
    if (Math.abs(n) >= value) {
      const x = n / value
      return `${x >= 100 ? Math.round(x) : x >= 10 ? x.toFixed(1) : x.toFixed(2)}${unit}`
    }
  }
  return String(n)
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
