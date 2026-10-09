// The thesis layer's status writer: after each survey tick (and after each
// judge run, for the judged claims), store every measured claim's readings
// and append a status-change row for any claim whose status moved. Readings are upserted (a recomputed day whose inputs were
// revised is rewritten; an identical one is left alone, computed_at and
// all); status changes are append-only.

import { and, desc, eq, gte, sql } from 'drizzle-orm'

import type { ClaimDef, ClaimStatus, ThesisDef } from '#shared/utils/thesis-types'
import type { CompanyId } from '#shared/utils/companies'

import * as tables from '../db/schema'
import { contentHash } from '../pipeline/contracts'
import { judgedThrough } from '../pipeline/judge/pending'
import { chunk, D1_MAX_BOUND_PARAMS, type PipelineDb } from '../pipeline/store'
import { daysBefore } from '../utils/terminal-rankings'
import { evaluateJudgedClaim, type StoredVerdict } from './judged-status'
import { THESES } from './registry'
import { presentation, readSignal, recomputable, type SignalDeps } from './signals'
import { evaluateClaim, historyDays, type ClaimEvaluation, type StoredReading } from './status'

const READING_COLUMNS = 8

export interface ClaimRun {
  claim_id: string
  readings_written: number
  status: ClaimStatus
  changed: boolean
}

/** Stored readings a claim's rule reads, as the status rules take them. */
export async function storedReadings(
  db: PipelineDb,
  claim: ClaimDef,
): Promise<(StoredReading & typeof tables.claimReadings.$inferSelect)[]> {
  const [newest] = await db
    .select({ date: tables.claimReadings.date })
    .from(tables.claimReadings)
    .where(eq(tables.claimReadings.claim_id, claim.id))
    .orderBy(desc(tables.claimReadings.date))
    .limit(1)
  if (!newest) return []
  const rows = await db
    .select()
    .from(tables.claimReadings)
    .where(
      and(
        eq(tables.claimReadings.claim_id, claim.id),
        gte(tables.claimReadings.date, daysBefore(newest.date, historyDays(claim))),
      ),
    )
    .orderBy(tables.claimReadings.date)
  return rows.map((r) => {
    const detail = JSON.parse(r.detail) as { compare?: unknown }
    return { ...r, compare: typeof detail.compare === 'number' ? detail.compare : null }
  })
}

export function evaluationOf(claim: ClaimDef, readings: readonly StoredReading[]): ClaimEvaluation {
  const { fmt, comparatorName } = presentation(claim)
  return evaluateClaim(claim, readings, fmt, comparatorName)
}

/** Every verdict stored for a judged claim, newest first. */
export async function storedVerdicts(db: PipelineDb, claim: ClaimDef) {
  const rows = await db
    .select()
    .from(tables.claimVerdicts)
    .where(eq(tables.claimVerdicts.claim_id, claim.id))
    .orderBy(desc(tables.claimVerdicts.detected_at))
  return rows.map((r) => ({
    ...r,
    provider: r.provider as CompanyId,
    facts: JSON.parse(r.facts) as Record<string, unknown>,
  })) satisfies StoredVerdict[]
}

/** A claim's status now, from whatever its kind stores. */
export async function currentEvaluation(
  db: PipelineDb,
  thesis: ThesisDef,
  claim: ClaimDef,
  now: Date,
): Promise<ClaimEvaluation> {
  if (claim.spec.kind === 'measured') return evaluationOf(claim, await storedReadings(db, claim))
  const [verdicts, through] = await Promise.all([storedVerdicts(db, claim), judgedThrough(db)])
  return evaluateJudgedClaim(claim, thesis.company, verdicts, through, now.toISOString())
}

async function writeReadings(
  db: PipelineDb,
  thesis: ThesisDef,
  claim: ClaimDef,
  deps: SignalDeps,
): Promise<number> {
  if (claim.spec.kind !== 'measured') return 0
  const all = await readSignal(db, thesis.company, claim, deps, historyDays(claim))
  const readings = recomputable(claim.spec) ? all : all.slice(-1)
  const computed_at = deps.now().toISOString()
  const rows = readings.map((r) => ({
    thesis_id: thesis.id,
    claim_id: claim.id,
    date: r.date,
    value: r.value,
    detail: JSON.stringify(r.detail),
    computed_at,
    source_url: r.source_url,
    fetched_at: r.fetched_at,
  }))
  for (const part of chunk(rows, Math.floor(D1_MAX_BOUND_PARAMS / READING_COLUMNS))) {
    await db
      .insert(tables.claimReadings)
      .values(part)
      .onConflictDoUpdate({
        target: [tables.claimReadings.claim_id, tables.claimReadings.date],
        set: {
          value: sql`excluded.value`,
          detail: sql`excluded.detail`,
          computed_at: sql`excluded.computed_at`,
          source_url: sql`excluded.source_url`,
          fetched_at: sql`excluded.fetched_at`,
        },
        setWhere: sql`excluded.value != ${tables.claimReadings.value} or excluded.detail != ${tables.claimReadings.detail}`,
      })
  }
  return rows.length
}

/** The newest status-change row per claim — the claim's recorded status. */
export async function latestStatusChange(db: PipelineDb, claimId: string) {
  const [row] = await db
    .select()
    .from(tables.claimStatusChanges)
    .where(eq(tables.claimStatusChanges.claim_id, claimId))
    .orderBy(desc(tables.claimStatusChanges.changed_at))
    .limit(1)
  return row ?? null
}

export async function evaluateTheses(
  db: PipelineDb,
  deps: SignalDeps,
  theses: readonly ThesisDef[] = THESES,
  opts: { judgedOnly?: boolean } = {},
): Promise<ClaimRun[]> {
  const runs: ClaimRun[] = []
  for (const thesis of theses) {
    for (const claim of thesis.claims) {
      if (opts.judgedOnly && claim.spec.kind !== 'judged') continue
      const written = await writeReadings(db, thesis, claim, deps)
      const evaluation = await currentEvaluation(db, thesis, claim, deps.now())
      const previous = await latestStatusChange(db, claim.id)
      const changed = previous?.status !== evaluation.status
      if (changed) {
        const changed_at = deps.now().toISOString()
        await db.insert(tables.claimStatusChanges).values({
          id: contentHash({ claim_id: claim.id, status: evaluation.status, changed_at }),
          thesis_id: thesis.id,
          claim_id: claim.id,
          status: evaluation.status,
          previous_status: previous?.status ?? null,
          reading_date: evaluation.reading_date,
          reason: evaluation.reason,
          changed_at,
        })
      }
      runs.push({
        claim_id: claim.id,
        readings_written: written,
        status: evaluation.status,
        changed,
      })
    }
  }
  return runs
}
