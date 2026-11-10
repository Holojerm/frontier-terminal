import { and, desc, eq, inArray, like } from 'drizzle-orm'
import { z } from 'zod'

import * as tables from '#server/db/schema'
import { emitEvent } from '../../utils/events'
import { AlertRow, contentHash, type ProspectusPart } from '../contracts'
import { archivesCik, cellText, registrationTarget } from '../parsers/sec/filing-index'
import { coverName } from '../parsers/sec/prospectus'
import { MONTHS, docLines, docText } from '../parsers/sec/prospectus-doc'
import { PROSPECTUS_FLOOR_RULE, freshRegistrationKey, usd } from '../prospectus-floor'
import { amountsIn } from '../reported/figures'
import { insertRows, type PipelineDb } from '../store'
import type { RawReader } from './class-map'

// The judge's fallback for a registration filing the parser could not fully
// read. When the revenue or the cover terms of a fresh S-1 fail to parse
// (refresh.ts stores the rest and marks the read incomplete), GET
// /api/judge/pending offers the document's text as a FILING REVIEW entry, and
// the judge sends back the sentence it read each figure from.
//
// The model only finds the sentence. The Worker decides, against the
// document as R2 holds it:
//   1. the part is still unread by the parser, and not read by the judge before;
//   2. the quote is in the document verbatim (whitespace folded);
//   3. revenue: the quote says "revenue", writes the amount exactly as given,
//      and names the period ("nine months ended September 30, 2026");
//      offering: the quote writes each price to the cent and says "per share";
//   4. the figure is re-read from the quote here, never taken from the body.
// Accepted parts raise the prospectus-floor alert the parser would have
// raised, critical, saying that the judge read it and quoting the sentence;
// the parser's own alert for the same filing is then notable, so the press
// and the feed hear about a filing once. A rejection is silence plus an ops
// event, never a repair.

/** The parts the judge may read. The rest are spooled for a parser fix only. */
export const JUDGE_READABLE_PARTS = [
  'revenue',
  'offering',
] as const satisfies readonly ProspectusPart[]
export type JudgeReadablePart = (typeof JUDGE_READABLE_PARTS)[number]

const SPANS = { 3: 'three months', 6: 'six months', 9: 'nine months', 12: 'year' } as const

export const JudgeFilingReading = z.discriminatedUnion('part', [
  z.strictObject({
    source_id: z.string().min(1).max(200),
    part: z.literal('revenue'),
    quote: z.string().min(20).max(800),
    /** The amount exactly as the quote writes it: "$33.2 billion". */
    amount: z.string().min(1).max(40),
    months: z.union([z.literal(3), z.literal(6), z.literal(9), z.literal(12)]),
    period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.strictObject({
    source_id: z.string().min(1).max(200),
    part: z.literal('offering'),
    quote: z.string().min(20).max(800),
    price_low: z.number().positive().nullable(),
    price_high: z.number().positive().nullable(),
    price: z.number().positive().nullable(),
  }),
])
export type JudgeFilingReading = z.infer<typeof JudgeFilingReading>

/** Characters of revenue context and of cover text offered per filing. */
const REVENUE_CHARS = 24_000
const COVER_CHARS = 16_000
const WINDOW = 500

export interface FilingReview {
  source_id: string
  accession_no: string
  form: string
  filed: string
  /** The parts to read, and why the parser could not. */
  parts: { part: JudgeReadablePart; error: string }[]
  /** Text to read them from, each a verbatim run of the document's text. */
  excerpts: string[]
}

interface IncompleteRead {
  source_id: string
  raw_key: string
  source_url: string
  fetched_at: string
  failed: { part: JudgeReadablePart; error: string }[]
}

const fold = (s: string) => s.replace(/\s+/g, ' ').trim()

const PREFIX = 'prospectus-revenue-'

/** Fresh registration documents whose newest read left a judge-readable part unread. */
async function incompleteReads(db: PipelineDb, now: Date): Promise<IncompleteRead[]> {
  const runs = await db
    .select({
      source_id: tables.sourceRuns.source_id,
      parse_basis: tables.sourceRuns.parse_basis,
      raw_key: tables.snapshots.raw_key,
      source_url: tables.snapshots.source_url,
      fetched_at: tables.snapshots.fetched_at,
    })
    .from(tables.sourceRuns)
    .innerJoin(tables.snapshots, eq(tables.snapshots.id, tables.sourceRuns.snapshot_id))
    .where(
      and(
        like(tables.sourceRuns.source_id, `${PREFIX}%`),
        inArray(tables.sourceRuns.status, ['ok', 'unchanged', 'baseline']),
      ),
    )
    .orderBy(desc(tables.sourceRuns.started_at))
  const newest = new Map<string, (typeof runs)[number]>()
  for (const run of runs) if (!newest.has(run.source_id)) newest.set(run.source_id, run)
  const read = await readParts(db, [...newest.keys()])
  const out: IncompleteRead[] = []
  for (const run of newest.values()) {
    if (!freshRegistrationKey(run.source_id.slice(PREFIX.length), now.toISOString())) continue
    const basis = run.parse_basis ? (JSON.parse(run.parse_basis) as { problems?: string[] }) : null
    const failed = (basis?.problems ?? []).flatMap((p) => {
      const [part, ...rest] = p.split(': ')
      return (JUDGE_READABLE_PARTS as readonly string[]).includes(part!) &&
        !read.has(`${run.source_id}:${part}`)
        ? [{ part: part as JudgeReadablePart, error: rest.join(': ') }]
        : []
    })
    if (failed.length) out.push({ ...run, failed })
  }
  return out
}

/** `source_id:part` for every part the judge has already read. */
async function readParts(db: PipelineDb, sourceIds: readonly string[]): Promise<Set<string>> {
  if (!sourceIds.length) return new Set()
  const rows = await db
    .select({ source_id: tables.filingReadings.source_id, part: tables.filingReadings.part })
    .from(tables.filingReadings)
    .where(inArray(tables.filingReadings.source_id, [...sourceIds]))
  return new Set(rows.map((r) => `${r.source_id}:${r.part}`))
}

/** What a reading of each part is checked against: the cover's text, or the whole document's. */
function texts(html: string) {
  return {
    cover: fold(cellText(html.slice(0, 200_000))),
    body: fold(docText(docLines(html)).text),
  }
}

/** Runs of the document around each sentence that names revenue next to an amount. */
export function revenueExcerpts(body: string): string[] {
  const out: string[] = []
  let used = 0
  let last = -1
  for (const m of body.matchAll(/\brevenues?\b/gi)) {
    if (m.index < last) continue
    const start = Math.max(0, m.index - WINDOW / 2)
    const run = body.slice(start, start + WINDOW)
    if (!/\bended\b/i.test(run) || amountsIn(run).length === 0) continue
    if (used + run.length > REVENUE_CHARS) break
    out.push(run)
    used += run.length
    last = start + WINDOW
  }
  return out
}

/** The FILING REVIEW block: each fresh filing with a part to read, and its text. */
export async function filingReview(
  db: PipelineDb,
  readRaw: RawReader,
  now: Date = new Date(),
): Promise<FilingReview[]> {
  const out: FilingReview[] = []
  for (const read of await incompleteReads(db, now)) {
    const html = await readRaw(read.raw_key)
    if (html === null) continue
    const { cover, body } = texts(html)
    const target = registrationTarget(read.source_id.slice(PREFIX.length))
    const excerpts = read.failed.flatMap(({ part }) =>
      part === 'offering' ? [cover.slice(0, COVER_CHARS)] : revenueExcerpts(body),
    )
    out.push({
      source_id: read.source_id,
      accession_no: target.accession_no,
      form: target.form,
      filed: target.filed,
      parts: read.failed,
      excerpts,
    })
  }
  return out
}

const dateWords = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return `${MONTHS[m! - 1]} ${d}, ${y}`
}
const ENDED = new RegExp(String.raw`\bended (${MONTHS.join('|')}) (\d{1,2}), (\d{4})`, 'g')

/** Every "ended <Month D, YYYY>" date in a quote, as ISO dates, oldest first. */
function periodEnds(quote: string): string[] {
  return [...quote.matchAll(ENDED)]
    .map((m) => {
      const month = String(MONTHS.indexOf(m[1] as (typeof MONTHS)[number]) + 1).padStart(2, '0')
      return `${m[3]}-${month}-${m[2]!.padStart(2, '0')}`
    })
    .sort()
}

const cents = (n: number) => `$${n.toFixed(2)}`

type Checked =
  | { part: 'revenue'; values: { val: number; months: number; end: string; amount: string } }
  | {
      part: 'offering'
      values: { price_low: number | null; price_high: number | null; price: number | null }
    }

/** Why a reading doesn't hold against the document, or what it reads. */
export function checkReading(
  reading: JudgeFilingReading,
  doc: { cover: string; body: string },
): { ok: true; checked: Checked } | { ok: false; reason: string; detail: string } {
  const quote = fold(reading.quote)
  const where = reading.part === 'offering' ? doc.cover : doc.body
  if (!where.includes(quote))
    return { ok: false, reason: 'quote-not-in-document', detail: quote.slice(0, 120) }
  if (reading.part === 'revenue') {
    if (!/\brevenues?\b/i.test(quote))
      return { ok: false, reason: 'quote-names-no-revenue', detail: quote.slice(0, 120) }
    const amount = amountsIn(quote).find((a) => a.text === reading.amount && a.currency === 'USD')
    if (!amount) return { ok: false, reason: 'amount-not-in-quote', detail: reading.amount }
    const period = `${SPANS[reading.months]} ended ${dateWords(reading.period_end)}`
    const at = quote.toLowerCase().indexOf(period.toLowerCase())
    if (at === -1) return { ok: false, reason: 'period-not-in-quote', detail: period }
    // A sentence comparing two periods: the figure is for the latest one, and
    // is the amount written just before it ("… to $33.2 billion for the nine
    // months ended September 30, 2026").
    const latest = periodEnds(quote).at(-1)
    if (latest !== reading.period_end) {
      return {
        ok: false,
        reason: 'not-the-latest-period',
        detail: `${reading.period_end} < ${latest}`,
      }
    }
    const before = amountsIn(quote.slice(0, at)).at(-1)
    if (before?.text !== amount.text) {
      return {
        ok: false,
        reason: 'amount-not-for-period',
        detail: `${amount.text} (${before?.text ?? 'none'} precedes the period)`,
      }
    }
    return {
      ok: true,
      checked: {
        part: 'revenue',
        values: {
          // 33.2 × 1e9 is 33200000000.000004 in floating point.
          val: Math.round(amount.value),
          months: reading.months,
          end: reading.period_end,
          amount: amount.text,
        },
      },
    }
  }
  const { price_low, price_high, price } = reading
  if ((price_low === null) !== (price_high === null) || (price_low === null && price === null)) {
    return {
      ok: false,
      reason: 'no-price-range-or-price',
      detail: JSON.stringify({ price_low, price_high, price }),
    }
  }
  if (!/\bper share\b/i.test(quote))
    return { ok: false, reason: 'quote-says-no-per-share', detail: quote.slice(0, 120) }
  for (const n of [price_low, price_high, price]) {
    if (n !== null && !quote.includes(cents(n)))
      return { ok: false, reason: 'price-not-in-quote', detail: cents(n) }
  }
  return { ok: true, checked: { part: 'offering', values: { price_low, price_high, price } } }
}

export interface FilingReport {
  accepted: number
  alerts: number
  rejected: { reason: string; detail: string; source_id: string }[]
}

/** The alert the parser would have raised, from what the judge read and the Worker checked. */
function readingAlert(
  entity: string,
  target: ReturnType<typeof registrationTarget>,
  read: IncompleteRead,
  checked: readonly (Checked & { quote: string })[],
  changeIds: readonly string[],
): AlertRow {
  const revenue = checked.find((c) => c.part === 'revenue')
  const offering = checked.find((c) => c.part === 'offering')
  const terms = offering
    ? offering.values.price !== null
      ? `priced at ${cents(offering.values.price)} per share`
      : `price range ${cents(offering.values.price_low!)} to ${cents(offering.values.price_high!)} per share`
    : null
  const rev = revenue
    ? `${usd(revenue.values.val)} revenue for the ${SPANS[revenue.values.months as 3 | 6 | 9 | 12]} ended ${revenue.values.end}`
    : null
  const headline = `${entity} ${target.form}: ${[rev, terms].filter(Boolean).join('; ')}`
  const explanation = [
    `${entity} filed ${target.form} on ${target.filed} (accession ${target.accession_no}).`,
    `The parser could not read ${checked.map((c) => (c.part === 'offering' ? 'the cover terms' : 'the revenue')).join(' or ')} in this filing; the judge read ${checked.length === 1 ? 'it' : 'them'} from the filing's own words, checked verbatim against the document:`,
    ...checked.map((c) => `“${c.quote}”`),
  ].join(' ')
  return AlertRow.parse({
    id: contentHash({
      rule: PROSPECTUS_FLOOR_RULE,
      accession_no: target.accession_no,
      part: 'judge-read',
    }),
    // As the parser's own alert: an amendment's new figures are news; a first
    // S-1's critical alert is its s1-floor listing.
    severity: target.form === 'S-1' ? 'notable' : 'critical',
    headline,
    explanation,
    change_ids: JSON.stringify([...changeIds].sort()),
    rule: PROSPECTUS_FLOOR_RULE,
    created_at: read.fetched_at,
    source_url: read.source_url,
    fetched_at: read.fetched_at,
  })
}

/** Gate and store the filing readings of one judge run; raise one alert per filing. */
export async function applyFilingReadings(
  db: PipelineDb,
  readRaw: RawReader,
  readings: readonly JudgeFilingReading[],
  now: Date,
): Promise<FilingReport> {
  const report: FilingReport = { accepted: 0, alerts: 0, rejected: [] }
  if (!readings.length) return report
  const offered = new Map((await incompleteReads(db, now)).map((r) => [r.source_id, r]))
  const bySource = new Map<string, JudgeFilingReading[]>()
  for (const r of readings) bySource.set(r.source_id, [...(bySource.get(r.source_id) ?? []), r])

  for (const [source_id, group] of bySource) {
    const read = offered.get(source_id)
    if (!read) {
      for (const r of group)
        report.rejected.push({ reason: 'not-offered', detail: r.part, source_id })
      continue
    }
    const html = await readRaw(read.raw_key)
    if (html === null) {
      report.rejected.push({ reason: 'document-not-stored', detail: read.raw_key, source_id })
      continue
    }
    const doc = texts(html)
    const accepted: (Checked & { quote: string })[] = []
    for (const r of group) {
      if (!read.failed.some((f) => f.part === r.part) || accepted.some((a) => a.part === r.part)) {
        report.rejected.push({ reason: 'part-not-offered', detail: r.part, source_id })
        continue
      }
      const result = checkReading(r, doc)
      if (!result.ok) {
        report.rejected.push({ reason: result.reason, detail: result.detail, source_id })
        continue
      }
      accepted.push({ ...result.checked, quote: fold(r.quote) })
    }
    if (!accepted.length) continue

    const target = registrationTarget(source_id.slice(PREFIX.length))
    const changes = await db
      .select({ id: tables.changes.id })
      .from(tables.changes)
      .where(eq(tables.changes.source_url, read.source_url))
    const entity = coverName(html) ?? archivesCik(read.source_url)
    const alert = readingAlert(
      entity,
      target,
      read,
      accepted,
      changes.map((c) => c.id),
    )
    const [stored] = await db
      .select({ id: tables.alerts.id })
      .from(tables.alerts)
      .where(eq(tables.alerts.id, alert.id))
    if (!stored && (await insertRows(db, 'alerts', [alert]))) {
      await emitEvent('alerts.new')
      report.alerts++
    }
    await db
      .insert(tables.filingReadings)
      .values(
        accepted.map((a) => ({
          id: contentHash({ source_id, part: a.part }),
          source_id,
          accession_no: target.accession_no,
          part: a.part,
          quote: a.quote,
          values: JSON.stringify(a.values),
          alert_id: alert.id,
          source_url: read.source_url,
          fetched_at: read.fetched_at,
          read_at: now.toISOString(),
        })),
      )
      .onConflictDoNothing()
    report.accepted += accepted.length
  }
  return report
}
