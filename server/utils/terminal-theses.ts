// GET /api/theses: every open thesis with each claim's status, its newest
// reading, and the series its rule reads. The status is recomputed here from
// the stored readings by the same pure rules the evaluator uses, so the page
// and the status-change log cannot disagree; status_since comes from the log.

import { max } from 'drizzle-orm'

import type { ClaimView, ThesesData } from '#shared/utils/thesis-types'

import * as tables from '../db/schema'
import type { PipelineDb } from '../pipeline/store'
import { evaluationOf, latestStatusChange, storedReadings } from '../theses/evaluate'
import { THESES } from '../theses/registry'
import type { QueryContext } from './terminal-db'

export const THESES_CAVEAT =
  'A research journal, not investment advice. Statuses are computed from the terminal’s own stored data against kill conditions written before the data arrived; ' +
  'OpenRouter is one aggregator’s traffic, not market share. Judged claims stay unresolved until the judge rates them.'

/** Newest reading write — part of the cache key, because readings land after the poll tick that stamps the cache. */
export async function thesesStamp(db: PipelineDb): Promise<string> {
  const [row] = await db
    .select({ at: max(tables.claimReadings.computed_at) })
    .from(tables.claimReadings)
  return row?.at ?? 'none'
}

export async function queryTheses(db: PipelineDb, ctx: QueryContext): Promise<ThesesData> {
  const theses = []
  for (const { claims, ...thesis } of THESES) {
    const views: ClaimView[] = []
    for (const claim of claims) {
      const [readings, change] = await Promise.all([
        storedReadings(db, claim),
        latestStatusChange(db, claim.id),
      ])
      const evaluation = evaluationOf(claim, readings)
      const newest = readings.at(-1)
      views.push({
        id: claim.id,
        n: claim.n,
        text: claim.text,
        signal_label: claim.signal_label,
        signal_kind: claim.spec.kind,
        kill_condition: claim.kill_condition,
        status: evaluation.status,
        status_since: change?.status === evaluation.status ? change.changed_at : null,
        reason: evaluation.reason,
        latest: newest
          ? {
              date: newest.date,
              value: newest.value,
              detail: JSON.parse(newest.detail) as unknown,
              source_url: newest.source_url,
              fetched_at: newest.fetched_at,
            }
          : null,
        series: readings.map((r) => ({ date: r.date, value: r.value })),
      })
    }
    theses.push({ ...thesis, claims: views })
  }
  return {
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
    theses,
    caveat: THESES_CAVEAT,
  }
}
