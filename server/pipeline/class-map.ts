import { desc } from 'drizzle-orm'

import * as tables from '../db/schema'
import { MODEL_CLASS_MAP, type ClassEntry } from '../utils/terminal-classes'
import type { PipelineDb } from './store'

// The class map in effect: the hand-transcribed seed (terminal-classes.ts)
// with the newest judge decision per (provider, class) laid over it
// (class_map_decisions, written only by server/pipeline/judge/class-map.ts).
// Read once per poll, for the drift check, and once per /api/prices, for the
// matrix, so the two always judge the same mapping.

type Decision = Pick<
  typeof tables.classMapDecisions.$inferSelect,
  'provider' | 'class' | 'model_slug' | 'basis' | 'basis_source_id' | 'decided_at' | 'fetched_at'
>

/** Pure: the seed with each cell's newest decision in its place. */
export function overlayClassMap(
  seed: readonly ClassEntry[],
  decisions: readonly Decision[],
): ClassEntry[] {
  const newest = new Map<string, Decision>()
  for (const d of decisions) {
    const key = `${d.provider}:${d.class}`
    const held = newest.get(key)
    if (!held || d.decided_at > held.decided_at) newest.set(key, d)
  }
  const out: ClassEntry[] = []
  for (const entry of seed) {
    const key = `${entry.provider}:${entry.class}`
    const d = newest.get(key)
    newest.delete(key)
    out.push(d ? fromDecision(d) : entry)
  }
  // A decision for a cell the seed leaves as a gap fills it.
  for (const d of newest.values()) out.push(fromDecision(d))
  return out
}

function fromDecision(d: Decision): ClassEntry {
  return {
    provider: d.provider as ClassEntry['provider'],
    class: d.class as ClassEntry['class'],
    model_slug: d.model_slug,
    basis: d.basis,
    basis_source_id: d.basis_source_id,
    verified_at: d.fetched_at,
  }
}

export async function effectiveClassMap(db: PipelineDb): Promise<ClassEntry[]> {
  const decisions = await db
    .select()
    .from(tables.classMapDecisions)
    .orderBy(desc(tables.classMapDecisions.decided_at))
  return overlayClassMap(MODEL_CLASS_MAP, decisions)
}
