// UN Comtrade's keyless public API, for Korea's monthly exports of HS 8542
// (electronic integrated circuits) to the world. getDA lists every monthly
// dataset Korea has released with when it was first and last released; the
// preview endpoint returns one period's figure (it refuses more than one
// period a call). The figure is what Comtrade holds now, so it was public
// from the dataset's lastReleased, not its firstReleased: that is the time
// each row is dated (sources.yaml › print_sources › un-comtrade-hs8542).

import { z } from 'zod'

import type { PrintObservation } from './parse'

export const COMTRADE = {
  source_id: 'un-comtrade-hs8542',
  reporter: 410, // Republic of Korea
  cmd: '8542',
  /** The first month the series holds. */
  from: '2013-01',
} as const

const BASE = 'https://comtradeapi.un.org/public/v1'

export const comtradeAvailabilityUrl = () =>
  `${BASE}/getDA/C/M/HS?reporterCode=${COMTRADE.reporter}`

/** One period's exports to the world, every customs regime, transport mode and second partner taken together. */
export const comtradePreviewUrl = (period: string) =>
  `${BASE}/preview/C/M/HS?reporterCode=${COMTRADE.reporter}&period=${period.replace('-', '')}` +
  `&cmdCode=${COMTRADE.cmd}&flowCode=X&partnerCode=0&partner2Code=0&customsCode=C00&motCode=0`

/** Comtrade's times carry no zone and are UTC; seven fractional digits. */
function utc(stamp: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(stamp)
  if (!m) throw new Error(`not a Comtrade time: ${stamp}`)
  return new Date(`${m[1]}Z`).toISOString()
}

const daRow = z.object({
  period: z.number().int(),
  reporterCode: z.number().int(),
  freqCode: z.literal('M'),
  classificationCode: z.string(),
  firstReleased: z.string(),
  lastReleased: z.string(),
})

interface ComtradeRelease {
  /** YYYY-MM */
  period: string
  classification: string
  first_released: string
  last_released: string
}

/** getDA's answer: each monthly dataset Korea has released, oldest first. */
export function parseComtradeAvailability(body: string): ComtradeRelease[] {
  const parsed = z
    .object({ data: z.array(daRow), error: z.string().nullish() })
    .parse(JSON.parse(body))
  if (parsed.error) throw new Error(`getDA: ${parsed.error}`)
  return parsed.data
    .filter((r) => r.reporterCode === COMTRADE.reporter)
    .map((r) => {
      const p = String(r.period)
      return {
        period: `${p.slice(0, 4)}-${p.slice(4, 6)}`,
        classification: r.classificationCode,
        first_released: utc(r.firstReleased),
        last_released: utc(r.lastReleased),
      }
    })
    .filter((r) => r.period >= COMTRADE.from)
    .sort((a, b) => a.period.localeCompare(b.period))
}

const previewRow = z.object({
  period: z.string(),
  reporterCode: z.number().int(),
  flowCode: z.string(),
  partnerCode: z.number().int(),
  partner2Code: z.number().int(),
  cmdCode: z.string(),
  customsCode: z.string(),
  motCode: z.number().int(),
  primaryValue: z.number(),
})

/**
 * One period's figure, dated public at `release.last_released`. An empty
 * answer is null: the period is listed but its row isn't served yet.
 * Comtrade states no year-on-year change; the signals loader derives one.
 */
export function parseComtradePreview(
  body: string,
  release: ComtradeRelease,
): PrintObservation | null {
  const parsed = z
    .object({ data: z.array(z.unknown()).nullish(), error: z.string().nullish() })
    .parse(JSON.parse(body))
  if (parsed.error) throw new Error(`preview: ${parsed.error}`)
  const rows = (parsed.data ?? []).map((r) => previewRow.parse(r))
  if (rows.length === 0) return null
  const want = release.period.replace('-', '')
  const total = rows.filter(
    (r) =>
      r.period === want &&
      r.reporterCode === COMTRADE.reporter &&
      r.flowCode === 'X' &&
      r.partnerCode === 0 &&
      r.partner2Code === 0 &&
      r.cmdCode === COMTRADE.cmd &&
      r.customsCode === 'C00' &&
      r.motCode === 0,
  )
  if (total.length !== 1) throw new Error(`preview ${want}: ${total.length} world-total rows`)
  const value = total[0]!.primaryValue
  if (!(value > 0)) throw new Error(`preview ${want}: value ${value}`)
  return {
    series: 'kr_hs8542_exports',
    entity: 'kr-semiconductors',
    ticker: null,
    period: release.period,
    window: 'month',
    value,
    currency: 'USD',
    yoy_pct: null,
    observed_as: 'print',
    published_at: release.last_released,
    due_on: null,
  }
}
