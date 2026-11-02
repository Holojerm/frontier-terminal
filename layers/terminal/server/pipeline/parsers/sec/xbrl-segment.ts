import {
  registerParser,
  XbrlSegmentOutput,
  type ParserId,
  type Provenance,
  type RevenueRow,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { REVENUE_TAGS } from './edgar-companyfacts'
import { parseRevenueFilersBlock, type RevenueFilers } from './revenue-filers'
import { parseCikWhitelistBlock, type CikWhitelist } from './whitelist'

// xbrl-segment-<ticker>-<filed>-<accession> — one periodic filing's XBRL
// instance (www.sec.gov/Archives/edgar/data/{cik}/{accession}/{prefix}-{period}_htm.xml),
// derived per 10-Q/10-K from the filer's submissions feed (derived.ts).
// Company facts carry non-dimensional facts only, so a segment's revenue is
// readable nowhere else: this parser keeps the revenue tags (REVENUE_TAGS)
// reported on a context whose ONLY dimension is the filer's tagged
// StatementBusinessSegmentsAxis member. A context that also carries another
// member (OperatingSegmentsMember beside it, a product axis) is a slice of
// the segment, not the segment, and is skipped.
//
// The instance names the filing it belongs to (dei:EntityCentralIndexKey,
// dei:DocumentType), and a mismatch with the filer it was derived for throws,
// as does an instance with no revenue fact on the member: a renamed member
// must fail the source, not quietly empty the panel.

const SEGMENT_AXIS = 'us-gaap:StatementBusinessSegmentsAxis'

export interface SegmentTarget {
  ticker: string
  cik: string
  segment: string
  accession_no: string
  /** The filing date — the instance does not carry it; the derived key does. */
  filed: string
}

/**
 * The last calendar quarter-end strictly before a filing date — the period a
 * calendar-year filer's 10-Q/10-K covers, and the date its instance is named
 * after. Pure; a filer on another fiscal calendar 404s on the derived URL.
 */
export function periodBefore(fileDate: string): string {
  const y = Number(fileDate.slice(0, 4))
  const ends = [`${y - 1}-12-31`, `${y}-03-31`, `${y}-06-30`, `${y}-09-30`, `${y}-12-31`]
  return ends.filter((e) => e < fileDate).at(-1)!
}

/** The derived key for one filing: `<ticker>-<filed>-<accession>`, lowercase ticker. */
export function segmentKey(ticker: string, filed: string, accessionNo: string): string {
  return `${ticker.toLowerCase()}-${filed}-${accessionNo}`
}

/** A derived key read back against the audited blocks; throws when it names no segment filer. */
export function segmentTarget(
  key: string,
  filers: RevenueFilers,
  whitelist: CikWhitelist,
): SegmentTarget {
  const m = key.match(/^([a-z0-9]+)-(\d{4}-\d{2}-\d{2})-(\d{10}-\d{2}-\d{6})$/)
  if (!m) throw new Error(`xbrl-segment key is not <ticker>-<filed>-<accession>: ${key}`)
  const ticker = m[1]!.toUpperCase()
  const filer = [...filers.values()].find((f) => f?.ticker === ticker)
  const cik = whitelist.get(ticker)
  if (!filer?.segment || !cik) {
    throw new Error(`xbrl-segment ${key}: ${ticker} is not a segment filer in sources.yaml`)
  }
  return { ticker, cik, segment: filer.segment, accession_no: m[3]!, filed: m[2]! }
}

interface Context {
  start: string
  end: string
}

/** Contexts whose one dimension is the segment member, with a duration period. */
function segmentContexts(xml: string, segment: string): Map<string, Context> {
  const out = new Map<string, Context>()
  const re = /<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g
  for (const m of xml.matchAll(re)) {
    const body = m[2]!
    if (/typedMember/.test(body)) continue
    const members = [
      ...body.matchAll(/<xbrldi:explicitMember\s+dimension="([^"]+)"\s*>\s*([^<\s]+)\s*</g),
    ]
    if (members.length !== 1) continue
    if (members[0]![1] !== SEGMENT_AXIS || members[0]![2] !== segment) continue
    const start = body.match(/<(?:xbrli:)?startDate>\s*([\d-]{10})\s*</)?.[1]
    const end = body.match(/<(?:xbrli:)?endDate>\s*([\d-]{10})\s*</)?.[1]
    if (start && end) out.set(m[1]!, { start, end })
  }
  return out
}

/** Unit ids that are plain USD (one iso4217:USD measure, no divide). */
function usdUnits(xml: string): Set<string> {
  const out = new Set<string>()
  const re = /<(?:xbrli:)?unit\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?unit>/g
  for (const m of xml.matchAll(re)) {
    const measures = [...m[2]!.matchAll(/<(?:xbrli:)?measure>\s*([^<\s]+)\s*</g)]
    if (!/divide/.test(m[2]!) && measures.length === 1 && measures[0]![1] === 'iso4217:USD') {
      out.add(m[1]!)
    }
  }
  return out
}

function dei(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<dei:${name}\\b[^>]*>([^<]*)</dei:${name}>`))
  return m ? m[1]!.trim() : null
}

const attr = (attrs: string, name: string) =>
  attrs.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1] ?? null

export function parseXbrlSegment(
  xml: string,
  target: SegmentTarget,
  prov: Provenance,
): { rows: RevenueRow[]; form: string; period_end: string | null } {
  const cik = dei(xml, 'EntityCentralIndexKey')
  if (cik?.padStart(10, '0') !== target.cik) {
    throw new Error(`instance is CIK ${cik}, derived for ${target.ticker} (CIK ${target.cik})`)
  }
  const form = dei(xml, 'DocumentType')
  const entityName = dei(xml, 'EntityRegistrantName')
  if (!form || !entityName)
    throw new Error('instance has no dei:DocumentType / EntityRegistrantName')
  const fyText = dei(xml, 'DocumentFiscalYearFocus')
  const fy = fyText && /^\d{4}$/.test(fyText) ? Number(fyText) : null

  const contexts = segmentContexts(xml, target.segment)
  const usd = usdUnits(xml)
  const rows: RevenueRow[] = []
  const byKey = new Map<string, number>()
  for (const tag of REVENUE_TAGS) {
    const re = new RegExp(`<us-gaap:${tag}\\b([^>]*)>([^<]*)</us-gaap:${tag}>`, 'g')
    for (const m of xml.matchAll(re)) {
      const ctx = contexts.get(attr(m[1]!, 'contextRef') ?? '')
      const unit = attr(m[1]!, 'unitRef')
      if (!ctx || !unit || !usd.has(unit)) continue
      const val = Number(m[2]!.trim())
      if (!Number.isFinite(val)) throw new Error(`${tag} on ${target.segment}: not a number`)
      // An instance repeats a fact once per statement it appears in.
      const key = `${tag}\n${ctx.start}\n${ctx.end}`
      const seen = byKey.get(key)
      if (seen !== undefined) {
        if (seen !== val) {
          throw new Error(
            `${tag} ${ctx.start}..${ctx.end} on ${target.segment}: ${seen} and ${val}`,
          )
        }
        continue
      }
      byKey.set(key, val)
      rows.push({
        cik: target.cik,
        entity_name: entityName,
        taxonomy: 'us-gaap',
        tag,
        unit: 'USD',
        start: ctx.start,
        end: ctx.end,
        val,
        accession_no: target.accession_no,
        fy,
        fp: dei(xml, 'DocumentFiscalPeriodFocus'),
        form,
        filed: target.filed,
        frame: null,
        segment: target.segment,
        whitelist_cik: target.cik,
        ...prov,
      })
    }
  }
  if (!rows.length) {
    throw new Error(`no ${REVENUE_TAGS.join(' / ')} fact on ${target.segment} in this instance`)
  }

  rows.sort((a, b) => {
    const ka = `${a.tag}|${a.start}|${a.end}`
    const kb = `${b.tag}|${b.start}|${b.end}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return {
    rows: XbrlSegmentOutput.parse({ rows }).rows,
    form,
    period_end: dei(xml, 'DocumentPeriodEndDate'),
  }
}

/** The representative fixture the shared parser is gated on (fixtures/manifest.json). */
export const SEGMENT_FIXTURE = {
  sourceId: 'xbrl-segment-googl-2026-10-29-0001652044-26-000084',
  key: 'googl-2026-10-29-0001652044-26-000084',
  path: 'fixtures/sec/xbrl-segment-googl-2026-10-29.xml',
} as const

registerParser({
  name: SEGMENT_FIXTURE.sourceId as ParserId,
  lane: 'sec',
  fixturePath: SEGMENT_FIXTURE.path,
  sideFixturePaths: ['sources.yaml'],
  schema: XbrlSegmentOutput,
  parse: (text, side) => {
    const yaml = side('sources.yaml')
    const target = segmentTarget(
      SEGMENT_FIXTURE.key,
      parseRevenueFilersBlock(yaml),
      parseCikWhitelistBlock(yaml),
    )
    return XbrlSegmentOutput.parse({
      rows: parseXbrlSegment(text, target, fixtureProvenance(SEGMENT_FIXTURE.sourceId)).rows,
    })
  },
})
