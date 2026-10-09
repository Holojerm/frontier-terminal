// GET /api/theses: every open thesis with each claim's status, its newest
// reading, and the series its rule reads. The status is recomputed here from
// the stored readings by the same pure rules the evaluator uses, so the page
// and the status-change log cannot disagree; status_since comes from the log.

import { max } from 'drizzle-orm'

import type { ClaimView, ThesesData } from '#shared/utils/thesis-types'

import * as tables from '../db/schema'
import type { PipelineDb } from '../pipeline/store'
import {
  currentEvaluation,
  latestStatusChange,
  storedReadings,
  storedVerdicts,
} from '../theses/evaluate'
import { confirmationOf } from '../theses/judged-status'
import { THESES } from '../theses/registry'
import type { QueryContext } from './terminal-db'

export const THESES_CAVEAT =
  'A research journal, not investment advice. Statuses are computed from the terminal’s own stored data against kill conditions written before the data arrived; ' +
  'OpenRouter is one aggregator’s traffic, not market share. Judged claims stay unresolved until the judge rates them.'

/** Newest reading and verdict writes — part of the cache key, because both land after the poll tick that stamps the cache. */
export async function thesesStamp(db: PipelineDb): Promise<string> {
  const [[readings], [verdicts]] = await Promise.all([
    db.select({ at: max(tables.claimReadings.computed_at) }).from(tables.claimReadings),
    db.select({ at: max(tables.claimVerdicts.judged_at) }).from(tables.claimVerdicts),
  ])
  return `${readings?.at ?? 'none'}|${verdicts?.at ?? 'none'}`
}

export async function queryTheses(db: PipelineDb, ctx: QueryContext): Promise<ThesesData> {
  const theses = []
  for (const def of THESES) {
    const { claims, ...thesis } = def
    const views: ClaimView[] = []
    for (const claim of claims) {
      const [readings, verdicts, change, evaluation] = await Promise.all([
        storedReadings(db, claim),
        claim.spec.kind === 'judged' ? storedVerdicts(db, claim) : [],
        latestStatusChange(db, claim.id),
        currentEvaluation(db, def, claim, ctx.now()),
      ])
      const spec = claim.spec
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
        verdicts: verdicts.map((v) => ({
          subject: v.subject,
          change_id: v.change_id,
          provider: v.provider,
          verdict: v.verdict,
          rationale: v.rationale,
          facts: v.facts,
          detected_at: v.detected_at,
          judged_at: v.judged_at,
          confirmation:
            spec.kind === 'judged' ? (confirmationOf(spec, v.subject)?.decision ?? null) : null,
          source_url: v.source_url,
          fetched_at: v.fetched_at,
        })),
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
