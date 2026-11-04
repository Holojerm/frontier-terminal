// The /track-record payload: for each material alert since TRACK_RECORD_FROM,
// when we saw the change against the first same-event press article and
// newsroom post. A side shows a time only when the judge rated a candidate
// the same event and every earlier candidate was rated not; anything short of
// that is a stated state ("not yet rated"), never a guessed lead.
//
// Every table read here is append-only, so `as_of` is a cut on the column
// that says when each row was written (searched_at, found_at, judged_at), and
// the alerts are the ones the store held then (terminal-asof.ts).

import { and, asc, gte, inArray, lte, max } from 'drizzle-orm'

import type {
  ProviderId,
  TrackRecordData,
  TrackRecordHit,
  TrackRecordRow,
  TrackRecordSide,
  TrackRecordState,
  TrackRecordTally,
} from '../../shared/utils/terminal-types'
import type { AlertSeverity } from '../../shared/utils/terminal-tiers'

import * as tables from '#server/db/schema'
import { ChangeRow } from '../pipeline/contracts'
import { MATERIAL_SEVERITIES } from '../pipeline/track-record/search'
import {
  TRACK_RECORD_FROM,
  WINDOW_DAYS,
  leadHours,
  median,
  sawIt,
  searchState,
  trackWindow,
} from '../pipeline/track-record/window'
import { D1_MAX_BOUND_PARAMS, chunk, type PipelineDb } from '../pipeline/store'
import { alertsKnownAt, judgeCutoffAt } from './terminal-asof'
import type { QueryContext } from './terminal-db'

type Candidate = typeof tables.trackRecordCandidates.$inferSelect
type Verdict = typeof tables.trackRecordVerdicts.$inferSelect
type Search = typeof tables.trackRecordSearches.$inferSelect

/** A cache variant: the newest search or verdict, which the poll stamp does not see. */
export async function trackRecordStamp(db: PipelineDb): Promise<string> {
  const [[s], [v]] = await Promise.all([
    db.select({ at: max(tables.trackRecordSearches.searched_at) }).from(tables.trackRecordSearches),
    db.select({ at: max(tables.trackRecordVerdicts.judged_at) }).from(tables.trackRecordVerdicts),
  ])
  return `${s?.at ?? 'none'}|${v?.at ?? 'none'}`
}

/**
 * One side's state from its searches, candidates and verdicts. Candidates are
 * walked earliest first: the first one rated the same event is the hit, as
 * long as none before it is still unrated.
 */
export function sideOf(
  windowOpen: boolean,
  searches: readonly Pick<Search, 'status' | 'detail'>[],
  candidates: readonly Candidate[],
  verdicts: ReadonlyMap<string, Pick<Verdict, 'same_event' | 'rationale'>>,
  saw: string,
  noFeedState: TrackRecordState = 'not-searchable',
): TrackRecordSide {
  const side = (
    state: TrackRecordState,
    extra: Partial<TrackRecordSide> = {},
  ): TrackRecordSide => ({
    state,
    detail: null,
    hit: null,
    lead_hours: null,
    candidates: candidates.length,
    rated: candidates.filter((c) => verdicts.has(c.id)).length,
    ...extra,
  })
  if (windowOpen) return side('window-open')
  const ok = searches.find((s) => s.status === 'ok')
  if (!ok) {
    const skipped = searches.find((s) => s.status === 'skipped')
    if (skipped) return side(noFeedState, { detail: skipped.detail })
    const failed = searches.find((s) => s.status === 'failed')
    if (failed) return side('search-failed', { detail: failed.detail })
    return side('not-searched')
  }
  if (candidates.length === 0) return side('none-found')
  const ordered = [...candidates].sort(
    (a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id),
  )
  for (const c of ordered) {
    const v = verdicts.get(c.id)
    if (!v) return side('not-yet-rated')
    if (!v.same_event) continue
    const hit: TrackRecordHit = {
      title: c.title,
      outlet: c.outlet,
      url: c.url,
      published_at: c.published_at,
      rationale: v.rationale,
      source_url: c.source_url,
      fetched_at: c.fetched_at,
    }
    return side('matched', { hit, lead_hours: leadHours(saw, c.published_at) })
  }
  return side('no-match')
}

export function tally(rows: readonly TrackRecordSide[]): TrackRecordTally {
  const matched = rows.filter((r) => r.lead_hours !== null).map((r) => r.lead_hours!)
  return {
    matched: matched.length,
    led: matched.filter((h) => h >= 0.05).length,
    lagged: matched.filter((h) => h <= -0.05).length,
    tied: matched.filter((h) => Math.abs(h) < 0.05).length,
    median_lead_hours: median(matched),
    not_yet_rated: rows.filter((r) => r.state === 'not-yet-rated').length,
  }
}

async function inChunks<T>(
  ids: readonly string[],
  read: (group: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = []
  for (const group of chunk([...new Set(ids)], D1_MAX_BOUND_PARAMS - 5))
    out.push(...(await read(group)))
  return out
}

export async function queryTrackRecord(
  db: PipelineDb,
  ctx: QueryContext,
): Promise<TrackRecordData> {
  const at = ctx.at
  const now = at ? new Date(at) : ctx.now()
  const known = at ? alertsKnownAt(at, await judgeCutoffAt(db, at)) : undefined
  const alerts = await db
    .select()
    .from(tables.alerts)
    .where(
      and(
        gte(tables.alerts.created_at, TRACK_RECORD_FROM),
        inArray(tables.alerts.severity, [...MATERIAL_SEVERITIES]),
        known,
      ),
    )
    .orderBy(asc(tables.alerts.created_at), asc(tables.alerts.id))
  const alertIds = alerts.map((a) => a.id)
  const changeIds = alerts.flatMap((a) => JSON.parse(a.change_ids) as string[])

  const [changes, searches, candidates, verdicts] = await Promise.all([
    inChunks(changeIds, (g) =>
      db.select().from(tables.changes).where(inArray(tables.changes.id, g)),
    ),
    inChunks(alertIds, (g) =>
      db
        .select()
        .from(tables.trackRecordSearches)
        .where(
          and(
            inArray(tables.trackRecordSearches.alert_id, g),
            at ? lte(tables.trackRecordSearches.searched_at, at) : undefined,
          ),
        ),
    ),
    inChunks(alertIds, (g) =>
      db
        .select()
        .from(tables.trackRecordCandidates)
        .where(
          and(
            inArray(tables.trackRecordCandidates.alert_id, g),
            at ? lte(tables.trackRecordCandidates.found_at, at) : undefined,
          ),
        ),
    ),
    inChunks(alertIds, (g) =>
      db
        .select()
        .from(tables.trackRecordVerdicts)
        .where(
          and(
            inArray(tables.trackRecordVerdicts.alert_id, g),
            at ? lte(tables.trackRecordVerdicts.judged_at, at) : undefined,
          ),
        ),
    ),
  ])
  const changeById = new Map(changes.map((c) => [c.id, ChangeRow.parse(c)]))
  const verdictOf = new Map(verdicts.map((v) => [v.candidate_id, v]))

  const rows: TrackRecordRow[] = []
  for (const alert of alerts) {
    const cited = (JSON.parse(alert.change_ids) as string[])
      .map((id) => changeById.get(id))
      .filter((c): c is ChangeRow => c !== undefined)
    const saw = sawIt(cited)
    if (!saw) continue
    const window = trackWindow(saw.at)
    const open = searchState(window, now) === 'open'
    const own = (source: string) =>
      searches
        .filter((s) => s.alert_id === alert.id && s.source === source)
        .sort((a, b) => b.searched_at.localeCompare(a.searched_at))
    const kind = (k: string) => candidates.filter((c) => c.alert_id === alert.id && c.kind === k)
    rows.push({
      alert_id: alert.id,
      severity: alert.severity as AlertSeverity,
      headline: alert.headline,
      created_at: alert.created_at,
      providers: [...new Set(cited.map((c) => c.provider as ProviderId))],
      saw_at: saw.at,
      saw_source_url: saw.source_url,
      window_from: window.start,
      window_to: window.end,
      press: sideOf(open, own('gdelt'), kind('press'), verdictOf, saw.at),
      newsroom: sideOf(open, own('newsroom'), kind('newsroom'), verdictOf, saw.at, 'no-feed'),
    })
  }
  rows.reverse()

  return {
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
    from: TRACK_RECORD_FROM,
    window_days: WINDOW_DAYS,
    rows,
    press: tally(rows.map((r) => r.press)),
    newsroom: tally(rows.map((r) => r.newsroom)),
    window_open: rows.filter((r) => r.press.state === 'window-open').length,
  }
}
