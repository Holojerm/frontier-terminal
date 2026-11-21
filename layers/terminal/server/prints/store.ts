// The append-only write for hardware_prints. A figure is stored when the
// source has never given one for its month, or gave a different one last
// time; the same figure again is not a row. Each source's documents are read
// in release order (ingest.ts), so a chain's first vintage is the first
// release that printed the month.

import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../pipeline/store'
import type { PrintObservation } from './parse'
import type { PrintBasis } from '../../shared/utils/prints'

export interface PrintWrite {
  source_id: string
  source_url: string
  fetched_at: string
  raw_key: string | null
  basis: PrintBasis
}

const keyOf = (o: { series: string; entity: string; period: string; window: string }) =>
  `${o.series}|${o.entity}|${o.period}|${o.window}`

/** Different at the source's own precision: the sources print whole units of a thousand or a million. */
const differs = (a: number, b: number) => Math.abs(a - b) >= 0.5

/** Inserts the observations that are new or revised. Returns how many rows it wrote. */
export async function storeObservations(
  db: PipelineDb,
  observations: PrintObservation[],
  write: PrintWrite,
): Promise<{ added: number; revised: number }> {
  if (observations.length === 0) return { added: 0, revised: 0 }
  const t = tables.hardwarePrints
  const periods = [...new Set(observations.map((o) => o.period))]
  const entities = [...new Set(observations.map((o) => o.entity))]
  const held = await db
    .select({
      series: t.series,
      entity: t.entity,
      period: t.period,
      window: t.window,
      value: t.value,
      vintage: t.vintage,
    })
    .from(t)
    .where(
      and(
        eq(t.source_id, write.source_id),
        inArray(t.entity, entities),
        inArray(t.period, periods),
      ),
    )
    .orderBy(desc(t.vintage))
  const latest = new Map<string, { value: number; vintage: number }>()
  for (const h of held) if (!latest.has(keyOf(h))) latest.set(keyOf(h), h)

  // A release that states a month twice (as the print and as a restatement)
  // says the same thing; the print wins.
  const rank = { print: 0, prior_month: 1, year_ago: 2 } as const
  const ordered = [...observations].sort((a, b) => rank[a.observed_as] - rank[b.observed_as])

  const rows: (typeof t.$inferInsert)[] = []
  let revised = 0
  for (const o of ordered) {
    const key = keyOf(o)
    const prev = latest.get(key)
    if (prev && !differs(prev.value, o.value)) continue
    const vintage = (prev?.vintage ?? 0) + 1
    if (prev) revised++
    latest.set(key, { value: o.value, vintage })
    rows.push({
      id: `${key}|${write.source_id}|${vintage}`,
      ...o,
      vintage,
      first_seen_at: write.fetched_at,
      basis: write.basis,
      source_id: write.source_id,
      source_url: write.source_url,
      fetched_at: write.fetched_at,
      raw_key: write.raw_key,
    })
  }
  // Under D1's 100 bound parameters a statement: 19 columns, so 4 rows each.
  for (let i = 0; i < rows.length; i += 4) {
    await db
      .insert(t)
      .values(rows.slice(i, i + 4))
      .onConflictDoNothing()
  }
  return { added: rows.length - revised, revised }
}

/** A change key for the route's cache: rows and the newest first sighting. */
export async function printsStamp(db: PipelineDb): Promise<string> {
  const [row] = await db
    .select({
      n: sql<number>`count(*)`,
      last: sql<string | null>`max(${tables.hardwarePrints.first_seen_at})`,
    })
    .from(tables.hardwarePrints)
  return `${row?.n ?? 0}:${row?.last ?? ''}`
}
