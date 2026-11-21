// The judge's reading of a call document the guidance parser found nothing in.
// GET /api/judge/pending offers each transcript, set of remarks or replay read with no
// statement but with sentences that look ahead and state a figure, as a GUIDANCE REVIEW
// entry (those sentences verbatim, and the reported quarter). The judge sends back, per
// document, the figures management guided, or none.
//
// The model only finds the sentence and says what it states. The Worker decides, against
// the document as R2 holds it:
//   1. the document was offered and is not judged yet;
//   2. the quote is in the document verbatim and is at most QUOTE_MAX_WORDS words;
//   3. the quote names the metric and states the guided figure, as the parser
//      reads it (firstAmount, the same rules);
//   4. the period ends after the reported quarter, within three fiscal years;
//   5. the ticker, dates, source and provenance are set here, never by the model.
// A statement that fails is dropped, with an ops event. An answered document is judged and
// never offered again.

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'

import * as tables from '#server/db/schema'
import { callCompany, type CallCompany } from './curated'
import { BOUNDS, firstAmount, METRICS, QUOTE_MAX_WORDS, UNITS, type Statement } from './extract'
import { guidanceRows } from './ingest'
import { fiscalPeriod, reportedQuarter } from './periods'
import type { DocSentence } from './text'
import { judgeReview } from '#layers/core/server/pipeline/judge/review'

/** Documents offered per judge run, newest call first. */
export const GUIDANCE_REVIEW_LIMIT = 3
/** Sentences offered per document. */
export const GUIDANCE_EXCERPTS = 40

const CANDIDATE =
  /\b(?:expect|anticipat|guid|outlook|forecast|target|project)\w*\b[^.]*?(?:\$\s?\d|\d\s?(?:%|percent))|(?:\$\s?\d|\d\s?(?:%|percent))[^.]*?\b(?:expect|anticipat|guid|outlook|forecast|target|project)\w*\b/i

const JudgeGuidanceStatement = z.strictObject({
  metric: z.enum(METRICS),
  segment: z.string().min(1).max(80).nullable(),
  unit: z.enum(UNITS),
  bound: z.enum(BOUNDS),
  low: z.number().positive(),
  high: z.number().positive(),
  fiscal_year: z.number().int().min(2018).max(2032),
  fiscal_quarter: z.number().int().min(1).max(4).nullable(),
  quote: z.string().min(10).max(400),
})

export const JudgeGuidanceReading = z.strictObject({
  document_id: z.string().min(1).max(120),
  statements: JudgeGuidanceStatement.array().max(20),
})
export type JudgeGuidanceReading = z.infer<typeof JudgeGuidanceReading>

export interface GuidanceReview {
  document_id: string
  ticker: string
  company: string
  kind: string
  call_date: string
  /** The quarter the call reported: a figure for it, or before it, is a result, not guidance. */
  reported: string
  /** The month the company's fiscal year ends in, so a fiscal year can be named. */
  fiscal_year_end_month: number
  /** Sentences that look ahead and state a figure, verbatim, with the speaker where known. */
  excerpts: { text: string; speaker: string | null }[]
}

async function stored(readRaw: RawReader, key: string | null): Promise<DocSentence[] | null> {
  const body = key ? await readRaw(key) : null
  if (!body) return null
  return (JSON.parse(body) as { sentences: DocSentence[] }).sentences
}

const pendingQuery = (db: PipelineDb) =>
  db
    .select()
    .from(tables.callDocuments)
    .where(
      and(
        eq(tables.callDocuments.status, 'read'),
        eq(tables.callDocuments.statements, 0),
        isNull(tables.callDocuments.judged_at),
        inArray(tables.callDocuments.kind, ['transcript', 'remarks', 'audio']),
      ),
    )
    .orderBy(desc(tables.callDocuments.call_date))

const candidatesOf = (doc: { kind: string }, c: CallCompany, sentences: readonly DocSentence[]) => {
  const execs = doc.kind === 'audio' && c.speakers ? new Set(c.speakers.map((s) => s.name)) : null
  return sentences.filter(
    (s) =>
      CANDIDATE.test(s.text) &&
      !s.text.trim().endsWith('?') &&
      (!execs || (s.speaker && execs.has(s.speaker))),
  )
}

/**
 * The GUIDANCE REVIEW block. A document with no candidate sentence is marked
 * judged on the way, so it is never read again.
 */
export async function guidanceReview(
  db: PipelineDb,
  readRaw: RawReader,
  now: Date,
  limit = GUIDANCE_REVIEW_LIMIT,
): Promise<GuidanceReview[]> {
  const out: GuidanceReview[] = []
  for (const doc of await pendingQuery(db).limit(limit * 4)) {
    if (out.length >= limit) break
    const sentences = await stored(readRaw, doc.raw_key)
    if (!sentences) continue
    const c = callCompany(doc.ticker)
    const candidates = candidatesOf(doc, c, sentences)
    if (!candidates.length) {
      await db
        .update(tables.callDocuments)
        .set({ judged_at: now.toISOString() })
        .where(eq(tables.callDocuments.id, doc.id))
      continue
    }
    out.push({
      document_id: doc.id,
      ticker: doc.ticker,
      company: c.company,
      kind: doc.kind,
      call_date: doc.call_date,
      reported: doc.period_label,
      fiscal_year_end_month: c.fy_end_month,
      excerpts: candidates
        .slice(0, GUIDANCE_EXCERPTS)
        .map((s) => ({ text: s.text, speaker: s.speaker })),
    })
  }
  return out
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const METRIC_CUE: Readonly<Record<string, RegExp>> = {
  capex: /capital|cap ?ex/i,
  revenue: /revenue|sales/i,
  segment_revenue: /revenue|sales/i,
  ai_revenue: /revenue|sales/i,
  gross_margin: /gross margin/i,
  backlog: /backlog|performance obligation|RPO/i,
}

type JudgedStatement = z.infer<typeof JudgeGuidanceStatement>

/** Why a judged statement doesn't hold against the document, or null when it does. */
export function checkStatement(
  s: JudgedStatement,
  text: string,
  fyEndMonth: number,
  reportedEnd: string,
): { reason: string; detail: string } | null {
  const quote = squash(s.quote)
  const short = quote.slice(0, 120)
  if (!squash(text).includes(quote)) return { reason: 'quote-not-in-document', detail: short }
  if (quote.split(/\s+/).length > QUOTE_MAX_WORDS)
    return { reason: 'quote-too-long', detail: short }
  if (!METRIC_CUE[s.metric]!.test(quote)) return { reason: 'metric-not-in-quote', detail: s.metric }
  const amount = firstAmount(quote)
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 0.005)
  if (!amount || !near(amount.low, s.low) || !near(amount.high, s.high)) {
    return { reason: 'figure-not-in-quote', detail: `${s.low}..${s.high}` }
  }
  const p = fiscalPeriod(fyEndMonth, s.fiscal_year, s.fiscal_quarter)
  if (p.end <= reportedEnd) return { reason: 'period-not-ahead', detail: p.end }
  return null
}

export interface GuidanceReviewReport {
  accepted: number
  judged: number
  rejected: { reason: string; detail: string; document_id: string }[]
}

/** Gate and store the guidance readings of one judge run, then mark each document judged. */
export async function applyGuidanceReadings(
  db: PipelineDb,
  readRaw: RawReader,
  readings: readonly JudgeGuidanceReading[],
  now: Date,
): Promise<GuidanceReviewReport> {
  const report: GuidanceReviewReport = { accepted: 0, judged: 0, rejected: [] }
  if (!readings.length) return report
  const pending = new Map((await pendingQuery(db)).map((d) => [d.id, d]))
  for (const reading of readings) {
    const doc = pending.get(reading.document_id)
    if (!doc) {
      report.rejected.push({
        reason: 'not-offered',
        detail: reading.document_id,
        document_id: reading.document_id,
      })
      continue
    }
    pending.delete(doc.id)
    const sentences = await stored(readRaw, doc.raw_key)
    if (!sentences) {
      report.rejected.push({
        reason: 'document-not-stored',
        detail: String(doc.raw_key),
        document_id: doc.id,
      })
      continue
    }
    const c = callCompany(doc.ticker)
    const reported = reportedQuarter(c.fy_end_month, doc.call_date)
    const text = sentences.map((s) => s.text).join(' ')
    const kept: Statement[] = []
    for (const s of reading.statements) {
      const failed = checkStatement(s, text, c.fy_end_month, reported.end)
      if (failed) {
        report.rejected.push({ ...failed, document_id: doc.id })
        continue
      }
      const at = sentences.find((x) => squash(x.text).includes(squash(s.quote)))
      kept.push({
        metric: s.metric,
        segment: s.segment,
        basis: /\bnon[\s-]*GAAP\b/i.test(s.quote)
          ? 'non_gaap'
          : /\bGAAP\b/.test(s.quote)
            ? 'gaap'
            : null,
        unit: s.unit,
        bound: s.bound,
        low: s.low,
        high: s.high,
        period: fiscalPeriod(c.fy_end_month, s.fiscal_year, s.fiscal_quarter),
        quote: squash(s.quote),
        sentence: at?.text ?? s.quote,
        page: at?.page ?? null,
        at_ms: at?.at_ms ?? null,
        speaker: at?.speaker ?? null,
      })
    }
    const rows = guidanceRows(doc, c, kept, {
      raw_key: doc.raw_key!,
      now: now.toISOString(),
      method: 'judge',
    })
    for (const row of rows) await db.insert(tables.filedGuidance).values(row).onConflictDoNothing()
    await db
      .update(tables.callDocuments)
      .set({ judged_at: now.toISOString(), statements: rows.length })
      .where(eq(tables.callDocuments.id, doc.id))
    report.accepted += rows.length
    report.judged++
  }
  return report
}

/** The guidance review (server/registries/judge.ts): guidance read from a call document the parser found none in. */
export const GUIDANCE_REVIEW = judgeReview({
  key: 'guidance',
  reading: JudgeGuidanceReading,
  max: 10,
  empty: { accepted: 0, judged: 0, rejected: [] } as GuidanceReviewReport,
  apply: ({ db, readRaw, now }, readings) => applyGuidanceReadings(db, readRaw, readings, now),
  rejected: { noun: 'guidance statement(s)', subject: 'document_id' },
  offer: {
    key: 'guidance_review',
    read: ({ db, readRaw, now }) => guidanceReview(db, readRaw, now),
  },
})
