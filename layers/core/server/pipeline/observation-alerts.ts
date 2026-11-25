// The shared half of the recipe-observation rules (adoption, data centers, rate limits, posted
// pay), the deal-score rule (layers/press/server/pipeline/deal-alerts.ts) and the supplier-passage
// rule (layers/companies/server/suppliers/alerts.ts): a rule turns two reads into findings, and
// this turns a finding into one change row and one alert, written once. Findings state facts
// from the cited row only, never advice, and are `notable` unless the rule says `info`: these
// rules never write `critical`, which posts to X and Bluesky
// (layers/alerts/server/pipeline/social.ts), and nothing here mails anyone.
//
// The change row's id and the alert's id hash the rule, the entity and the period the finding is
// about, so a re-run of the same reads writes nothing a second time. A finding about several labs
// (one supplier filing naming two) cites one further row per lab, keyed by the lab too, so the
// lab filter finds it under each; the alert's id still hashes the first row alone.

import { and, eq, gte, inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../utils/pipeline-store'
import { emitEvent } from '../utils/events'
import { AlertRow, ChangeRow, contentHash, type Provider } from '../utils/contracts'

type Json = Record<string, string | number | null>

export type ObservationRule =
  | 'adoption-floor'
  | 'datacenter-floor'
  | 'limits-floor'
  | 'pay-floor'
  | 'deal-score-floor'
  | 'supplier-passage-floor'

export type ObservationEntity =
  | 'adoption_series'
  | 'data_center'
  | 'rate_limit'
  | 'pay_band'
  | 'deal_score'
  | 'supplier_passage'

export interface Finding {
  rule: ObservationRule
  entity_type: ObservationEntity
  /** `<entity_type>:<what it is of>`, as the other rules key their rows. */
  entity_key: string
  provider: Provider
  /** What the finding is about, so the same period is never alerted twice: a week, a snapshot date. */
  period: string
  change_type: 'added' | 'modified'
  before: Json | null
  after: Json
  headline: string
  /** The sentences after the figures: what moved, what the source is, what the rule was. */
  explanation: string
  source_url: string
  fetched_at: string
  /** `notable` when absent. */
  severity?: 'info' | 'notable'
  /** Further rows the alert cites, one per other lab the finding is about. */
  also?: readonly { provider: Provider; after: Json }[]
}

export function findingRows(f: Finding, now: Date): { changes: ChangeRow[]; alert: AlertRow } {
  const detected_at = now.toISOString()
  const row = (id: string, provider: Provider, after: Json) =>
    ChangeRow.parse({
      id,
      entity_key: f.entity_key,
      entity_type: f.entity_type,
      provider,
      change_type: f.change_type,
      before_hash: f.before ? contentHash(f.before) : null,
      after_hash: contentHash(after),
      before_json: f.before ? JSON.stringify(f.before) : null,
      after_json: JSON.stringify(after),
      detected_at,
      source_url: f.source_url,
      fetched_at: f.fetched_at,
    })
  const key = { rule: f.rule, entity_key: f.entity_key, period: f.period }
  const lead = row(contentHash(key), f.provider, f.after)
  const changes = [
    lead,
    ...(f.also ?? []).map((a) =>
      row(contentHash({ ...key, provider: a.provider }), a.provider, a.after),
    ),
  ]
  const alert = AlertRow.parse({
    id: contentHash({ rule: f.rule, change_id: lead.id }),
    severity: f.severity ?? 'notable',
    headline: f.headline,
    explanation: f.explanation,
    change_ids: JSON.stringify(changes.map((c) => c.id)),
    rule: f.rule,
    created_at: detected_at,
    source_url: f.source_url,
    fetched_at: f.fetched_at,
  })
  return { changes, alert }
}

/** Writes the findings no earlier run wrote; returns how many were new. */
export async function writeFindings(
  db: PipelineDb,
  findings: readonly Finding[],
  now = new Date(),
): Promise<number> {
  if (findings.length === 0) return 0
  const rows = findings.map((f) => findingRows(f, now))
  const have = new Set(
    (
      await db
        .select({ id: tables.alerts.id })
        .from(tables.alerts)
        .where(
          inArray(
            tables.alerts.id,
            rows.map((r) => r.alert.id),
          ),
        )
    ).map((r) => r.id),
  )
  let written = 0
  for (const { changes, alert } of rows) {
    if (have.has(alert.id)) continue
    // The changes go first: the alert's insert trigger reads them into alert_cites. One at a
    // time, as nine lab rows in one insert would pass D1's bound-parameter cap.
    for (const change of changes)
      await db.insert(tables.changes).values(change).onConflictDoNothing()
    await db.insert(tables.alerts).values(alert).onConflictDoNothing()
    written += 1
  }
  if (written) await emitEvent('alerts.new')
  return written
}

/**
 * Whether an alert on this entity within the window already said the move in the same
 * direction. For a rule whose periods slide (a 7-day window), so one lasting move is one alert.
 */
export async function saidSince(
  db: PipelineDb,
  entity_key: string,
  sinceIso: string,
  direction: number,
  field: string,
): Promise<boolean> {
  const rows = await db
    .select({ after_json: tables.changes.after_json })
    .from(tables.changes)
    .where(
      and(eq(tables.changes.entity_key, entity_key), gte(tables.changes.detected_at, sinceIso)),
    )
  return rows.some((r) => {
    const v = (JSON.parse(r.after_json ?? '{}') as Record<string, unknown>)[field]
    return typeof v === 'number' && Math.sign(v) === Math.sign(direction)
  })
}

/**
 * Whether `change` is out of the series' own noise: at least `floor`, and at least `multiple`
 * times the median size of the earlier changes. Pure; the unit (percent, points) is the caller's.
 */
export function beyondNoise(
  change: number,
  earlier: readonly number[],
  floor: number,
  multiple = 3,
): boolean {
  const sizes = earlier.map(Math.abs).sort((a, b) => a - b)
  const mid = sizes.length >> 1
  const typical =
    sizes.length === 0 ? 0 : sizes.length % 2 ? sizes[mid]! : (sizes[mid - 1]! + sizes[mid]!) / 2
  return Math.abs(change) >= Math.max(floor, multiple * typical)
}
