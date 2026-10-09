// The thesis layer's one writer: after each survey tick, store every measured
// claim's readings and append a status-change row for any claim whose
// status moved. Readings are upserted (a recomputed day whose inputs were
// revised is rewritten; an identical one is left alone, computed_at and
// all); status changes are append-only.

import { and, desc, eq, gte, sql } from 'drizzle-orm'

import type { ClaimDef, ClaimStatus, ThesisDef } from '#shared/utils/thesis-types'

import * as tables from '../db/schema'
import { contentHash } from '../pipeline/contracts'
import { chunk, D1_MAX_BOUND_PARAMS, type PipelineDb } from '../pipeline/store'
import { daysBefore } from '../utils/terminal-rankings'
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
): Promise<ClaimRun[]> {
  const runs: ClaimRun[] = []
  for (const thesis of theses) {
    for (const claim of thesis.claims) {
      const written = await writeReadings(db, thesis, claim, deps)
      const evaluation = evaluationOf(claim, await storedReadings(db, claim))
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
