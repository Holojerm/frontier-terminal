// GET /api/theses: every open thesis with each claim's status, its newest
// reading, and the series its rule reads. The status is recomputed here from
// the stored readings by the same pure rules the evaluator uses, so the page
// and the status-change log cannot disagree; status_since comes from the log.

import { max } from 'drizzle-orm'

import { COMPANIES, companyName } from '../../shared/utils/companies'
import type { ClaimView, ReadingPoint, ThesesData } from '../../shared/utils/thesis-types'

import * as tables from '#server/db/schema'
import { contentHash } from '../pipeline/contracts'
import type { PipelineDb } from '../pipeline/store'
import {
  currentEvaluation,
  latestStatusChange,
  storedReadings,
  storedVerdicts,
} from '../theses/evaluate'
import { confirmationOf } from '../theses/judged-status'
import { THESES } from '../theses/registry'
import { valueFormatOf } from '../theses/signals'
import type { QueryContext } from './terminal-db'

export const THESES_CAVEAT =
  'This is a research journal. It isn’t investment advice. Each status is computed from our stored data against kill conditions written before the data arrived. ' +
  'OpenRouter is one aggregator’s traffic, so treat it as a rough read on demand. A judged claim stays unresolved until the judge rates it.'

/** The thesis definitions themselves: a deploy that adds a thesis, moves a
 * threshold or commits a confirmation must not be served a payload cached
 * before it. */
const DEFINITIONS = contentHash(THESES).slice(0, 12)

/** Newest reading and verdict writes plus the definitions — the cache key's
 * variant, because readings and verdicts land after the poll tick that
 * stamps the cache, and definitions change on deploy. */
export async function thesesStamp(db: PipelineDb): Promise<string> {
  const [[readings], [verdicts]] = await Promise.all([
    db.select({ at: max(tables.claimReadings.computed_at) }).from(tables.claimReadings),
    db.select({ at: max(tables.claimVerdicts.judged_at) }).from(tables.claimVerdicts),
  ])
  return `${DEFINITIONS}|${readings?.at ?? 'none'}|${verdicts?.at ?? 'none'}`
}

/** A reading as the chart and table show it, noting a change of mapped flagship or of the labs counted. */
function seriesPoint(r: { date: string; value: number; detail: string }): ReadingPoint {
  const detail = JSON.parse(r.detail) as {
    flagship_changed?: Record<string, unknown> | null
    lab_set_changed?: { added: string[]; removed: string[] } | null
  }
  const notes: string[] = []
  const changed = detail.flagship_changed
  if (changed) {
    const labs = Object.entries(changed)
      .map(([lab, c]) => {
        const { from, to } = c as { from: string; to: string }
        return `${companyName(lab)} ${from} → ${to}`
      })
      .join('; ')
    notes.push(`Flagship changed: ${labs}`)
  }
  const set = detail.lab_set_changed
  if (set) notes.push(labSetNote(set))
  return notes.length
    ? { date: r.date, value: r.value, note: notes.join('. ') }
    : { date: r.date, value: r.value }
}

/** 'Labs counted changed: Mistral joined; xAI left' */
function labSetNote(set: { added: string[]; removed: string[] }): string {
  const parts = [
    ...(set.added.length ? [`${set.added.map(companyName).join(', ')} joined`] : []),
    ...(set.removed.length ? [`${set.removed.map(companyName).join(', ')} left`] : []),
  ]
  return `Labs counted changed: ${parts.join('; ')}`
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
        format: valueFormatOf(claim),
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
        series: readings.filter((r) => !r.void_reason).map(seriesPoint),
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
    theses.push({
      ...thesis,
      title: thesis.title ?? companyName(thesis.company),
      company_name: companyName(thesis.company),
      ticker: COMPANIES[thesis.company].ticker,
      comparison_names: thesis.comparison_set.map(companyName),
      claims: views,
    })
  }
  return {
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
    theses,
    caveat: THESES_CAVEAT,
  }
}
