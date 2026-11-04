// The judge's half of the track record. GET /api/judge/pending offers each
// alert's unrated candidates as a TRACK RECORD REVIEW block; POST
// /api/judge/alerts sends back one same-event rating per candidate, and this
// file gates them the way claim verdicts are gated (theses/verdicts.ts): the
// candidate must exist, and the rationale must be grounded in the candidate's
// title and snippet plus the alert's own change rows. Only then is a verdict
// written, once per candidate.
//
// Candidates are offered earliest first, per alert and kind, and only up to
// the first one rated the same event: the first report is the one the page
// shows, so a later article never needs a rating.

import { asc, inArray } from 'drizzle-orm'
import { z } from 'zod'

import * as tables from '#server/db/schema'
import { ChangeRow, contentHash } from '../contracts'
import { corpusOf, groundingFailure } from '../judge/grounding'
import { D1_MAX_BOUND_PARAMS, chunk, type PipelineDb } from '../store'

/** Candidates offered per alert and kind per run. */
export const REVIEW_PER_SIDE = 5

/** Candidates offered per run, across every alert. */
export const REVIEW_LIMIT = 60

export const JudgeTrackRecordVerdict = z.strictObject({
  candidate_id: z.string().regex(/^[0-9a-f]{64}$/),
  same_event: z.boolean(),
  rationale: z.string().min(1).max(400),
})
export type JudgeTrackRecordVerdict = z.infer<typeof JudgeTrackRecordVerdict>

type Candidate = typeof tables.trackRecordCandidates.$inferSelect
type Verdict = typeof tables.trackRecordVerdicts.$inferSelect

export interface TrackRecordReview {
  alert_id: string
  headline: string
  explanation: string
  /** The cited change rows, as the judge's CHANGE RECORDS print them. */
  changes: ChangeRow[]
  candidates: {
    candidate_id: string
    kind: 'press' | 'newsroom'
    outlet: string
    title: string
    snippet: string | null
    published_at: string
  }[]
}

/**
 * Per alert and kind, the candidates still worth a rating: earliest first,
 * none after the earliest one already rated the same event, none already
 * rated, at most `perSide`.
 */
export function pendingCandidates(
  candidates: readonly Candidate[],
  verdicts: readonly Pick<Verdict, 'candidate_id' | 'same_event'>[],
  perSide: number = REVIEW_PER_SIDE,
): Candidate[] {
  const rated = new Map(verdicts.map((v) => [v.candidate_id, v.same_event]))
  const sides = new Map<string, Candidate[]>()
  for (const c of candidates) {
    const key = `${c.alert_id}:${c.kind}`
    sides.set(key, [...(sides.get(key) ?? []), c])
  }
  const out: Candidate[] = []
  for (const side of sides.values()) {
    side.sort((a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id))
    const offered: Candidate[] = []
    for (const c of side) {
      const verdict = rated.get(c.id)
      if (verdict === true) break
      if (verdict === false) continue
      offered.push(c)
      if (offered.length === perSide) break
    }
    out.push(...offered)
  }
  return out
}

async function verdictsFor(db: PipelineDb, alertIds: readonly string[]) {
  const out: Pick<Verdict, 'candidate_id' | 'same_event'>[] = []
  for (const group of chunk([...new Set(alertIds)], D1_MAX_BOUND_PARAMS)) {
    out.push(
      ...(await db
        .select({
          candidate_id: tables.trackRecordVerdicts.candidate_id,
          same_event: tables.trackRecordVerdicts.same_event,
        })
        .from(tables.trackRecordVerdicts)
        .where(inArray(tables.trackRecordVerdicts.alert_id, group))),
    )
  }
  return out
}

async function changesFor(db: PipelineDb, ids: readonly string[]): Promise<Map<string, ChangeRow>> {
  const out = new Map<string, ChangeRow>()
  for (const group of chunk([...new Set(ids)], D1_MAX_BOUND_PARAMS)) {
    const rows = await db.select().from(tables.changes).where(inArray(tables.changes.id, group))
    for (const row of rows) out.set(row.id, ChangeRow.parse(row))
  }
  return out
}

/** The TRACK RECORD REVIEW block, oldest alerts first, capped at `limit` candidates. */
export async function trackRecordReview(
  db: PipelineDb,
  limit: number = REVIEW_LIMIT,
): Promise<TrackRecordReview[]> {
  const candidates = await db
    .select()
    .from(tables.trackRecordCandidates)
    .orderBy(asc(tables.trackRecordCandidates.published_at))
  if (candidates.length === 0) return []
  const verdicts = await verdictsFor(
    db,
    candidates.map((c) => c.alert_id),
  )
  const pending = pendingCandidates(candidates, verdicts)
  if (pending.length === 0) return []

  const alertIds = [...new Set(pending.map((c) => c.alert_id))]
  const alerts = new Map<string, typeof tables.alerts.$inferSelect>()
  for (const group of chunk(alertIds, D1_MAX_BOUND_PARAMS)) {
    for (const a of await db.select().from(tables.alerts).where(inArray(tables.alerts.id, group)))
      alerts.set(a.id, a)
  }
  const ordered = alertIds
    .filter((id) => alerts.has(id))
    .sort((a, b) => alerts.get(a)!.created_at.localeCompare(alerts.get(b)!.created_at))

  const out: TrackRecordReview[] = []
  let offered = 0
  for (const id of ordered) {
    if (offered >= limit) break
    const own = pending.filter((c) => c.alert_id === id).slice(0, limit - offered)
    offered += own.length
    const alert = alerts.get(id)!
    out.push({
      alert_id: id,
      headline: alert.headline,
      explanation: alert.explanation,
      changes: [],
      candidates: own.map((c) => ({
        candidate_id: c.id,
        kind: c.kind as 'press' | 'newsroom',
        outlet: c.outlet,
        title: c.title,
        snippet: c.snippet,
        published_at: c.published_at,
      })),
    })
  }
  const changes = await changesFor(
    db,
    out.flatMap((r) => JSON.parse(alerts.get(r.alert_id)!.change_ids) as string[]),
  )
  for (const r of out) {
    r.changes = (JSON.parse(alerts.get(r.alert_id)!.change_ids) as string[])
      .map((cid) => changes.get(cid))
      .filter((c): c is ChangeRow => c !== undefined)
  }
  return out
}

export interface TrackRecordVerdictReport {
  accepted: number
  inserted: number
  rejected: { reason: string; detail: string; candidate_id: string }[]
}

/** What a rationale may cite: the candidate as shown, the alert's own text, and its change rows. */
export function reviewCorpus(
  candidate: Pick<Candidate, 'title' | 'snippet' | 'outlet' | 'published_at'>,
  alert: Pick<typeof tables.alerts.$inferSelect, 'headline' | 'explanation'>,
  changes: readonly ChangeRow[],
): string {
  return [
    candidate.title,
    candidate.snippet ?? '',
    candidate.outlet,
    candidate.published_at,
    alert.headline,
    alert.explanation,
    corpusOf(changes),
  ].join('\n')
}

/** Gate, ground and store the track-record verdicts of one judge run. */
export async function applyTrackRecordVerdicts(
  db: PipelineDb,
  verdicts: readonly JudgeTrackRecordVerdict[],
  now: Date,
): Promise<TrackRecordVerdictReport> {
  const report: TrackRecordVerdictReport = { accepted: 0, inserted: 0, rejected: [] }
  if (verdicts.length === 0) return report
  const candidates = new Map<string, Candidate>()
  for (const group of chunk(
    [...new Set(verdicts.map((v) => v.candidate_id))],
    D1_MAX_BOUND_PARAMS,
  )) {
    for (const c of await db
      .select()
      .from(tables.trackRecordCandidates)
      .where(inArray(tables.trackRecordCandidates.id, group)))
      candidates.set(c.id, c)
  }
  const alerts = new Map<string, typeof tables.alerts.$inferSelect>()
  for (const group of chunk(
    [...new Set([...candidates.values()].map((c) => c.alert_id))],
    D1_MAX_BOUND_PARAMS,
  )) {
    for (const a of await db.select().from(tables.alerts).where(inArray(tables.alerts.id, group)))
      alerts.set(a.id, a)
  }
  const changes = await changesFor(
    db,
    [...alerts.values()].flatMap((a) => JSON.parse(a.change_ids) as string[]),
  )
  const judged_at = now.toISOString()
  for (const verdict of verdicts) {
    const candidate = candidates.get(verdict.candidate_id)
    const alert = candidate ? alerts.get(candidate.alert_id) : undefined
    if (!candidate || !alert) {
      report.rejected.push({
        reason: 'unknown-candidate',
        detail: verdict.candidate_id,
        candidate_id: verdict.candidate_id,
      })
      continue
    }
    const cited = (JSON.parse(alert.change_ids) as string[])
      .map((id) => changes.get(id))
      .filter((c): c is ChangeRow => c !== undefined)
    const failure = groundingFailure(verdict.rationale, reviewCorpus(candidate, alert, cited))
    if (failure) {
      report.rejected.push({ ...failure, candidate_id: verdict.candidate_id })
      continue
    }
    report.accepted++
    const written = await db
      .insert(tables.trackRecordVerdicts)
      .values({
        id: contentHash({ candidate_id: candidate.id }),
        candidate_id: candidate.id,
        alert_id: candidate.alert_id,
        same_event: verdict.same_event,
        rationale: verdict.rationale,
        judged_at,
        source_url: candidate.url,
        fetched_at: candidate.fetched_at,
      })
      .onConflictDoNothing()
      .returning({ id: tables.trackRecordVerdicts.id })
    report.inserted += written.length
  }
  return report
}
