// /api/hiring/listed: per listed company, its newest board read, the weekly
// series (each week's last read, and its change on the week before), its
// newest data-center roles, and the boards we looked at and cut.

import { and, desc, eq, isNull, max } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import {
  LISTED_BOARDS,
  LISTED_CUTS,
  LISTED_HIRING_RULE,
  weeklyCounts,
  type ListedHiringBoard,
  type ListedHiringData,
  type RoleClass,
} from '../../shared/utils/listed-hiring'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'

/** Data-center roles listed per board on the page and in the tool. */
export const DATACENTER_ROLES_SHOWN = 12

/** The cache variant: the newest read, so a new read is a new payload. */
export async function listedHiringStamp(db: PipelineDb): Promise<string> {
  const [row] = await db
    .select({ at: max(tables.listedHiringReads.read_at) })
    .from(tables.listedHiringReads)
  return row?.at ?? ''
}

type Read = typeof tables.listedHiringReads.$inferSelect

export async function queryListedHiring(
  db: PipelineDb,
  now = new Date(),
): Promise<ListedHiringData> {
  const [reads, roles] = await Promise.all([
    db.select().from(tables.listedHiringReads).orderBy(tables.listedHiringReads.read_at),
    db
      .select({
        board_id: tables.listedJobs.board_id,
        job_id: tables.listedJobs.job_id,
        title: tables.listedJobs.title,
        department: tables.listedJobs.department,
        location: tables.listedJobs.location,
        role_class: tables.listedJobs.role_class,
        first_seen_at: tables.listedJobs.first_seen_at,
      })
      .from(tables.listedJobs)
      .where(
        and(eq(tables.listedJobs.role_class, 'datacenter'), isNull(tables.listedJobs.closed_at)),
      )
      .orderBy(desc(tables.listedJobs.first_seen_at), tables.listedJobs.job_id),
  ])

  const readsBy = new Map<string, Read[]>()
  for (const r of reads) readsBy.set(r.board_id, [...(readsBy.get(r.board_id) ?? []), r])

  const boards: ListedHiringBoard[] = LISTED_BOARDS.map((b) => {
    const mine = readsBy.get(b.id) ?? []
    const good = mine.filter((r) => r.status === 'read')
    const last = good.at(-1)
    const newest = mine.at(-1)
    return {
      id: b.id,
      ticker: b.ticker,
      company: b.company,
      platform: b.platform,
      scope: b.scope,
      host: b.host,
      caveat: b.caveat ?? null,
      latest: last
        ? {
            read_at: last.read_at,
            total: last.total,
            datacenter: last.datacenter ?? 0,
            infrastructure: last.infrastructure,
            source_url: last.source_url,
            fetched_at: last.fetched_at,
          }
        : null,
      weeks: weeklyCounts(
        good.map((r) => ({
          read_at: r.read_at,
          total: r.total,
          datacenter: r.datacenter ?? 0,
          infrastructure: r.infrastructure,
        })),
      ),
      datacenter_roles: roles
        .filter((r) => r.board_id === b.id)
        .slice(0, DATACENTER_ROLES_SHOWN)
        .map((r) => ({
          job_id: r.job_id,
          title: r.title,
          department: r.department,
          location: r.location,
          role_class: r.role_class as RoleClass,
          first_seen_at: r.first_seen_at,
        })),
      failing:
        newest && newest.status === 'failed'
          ? { read_at: newest.read_at, detail: newest.detail ?? 'failed' }
          : null,
    }
  })

  const asOf = reads.filter((r) => r.status === 'read').at(-1)?.read_at ?? null
  return {
    computed_at: now.toISOString(),
    as_of: asOf,
    rule: LISTED_HIRING_RULE,
    boards,
    cut: [...LISTED_CUTS],
  }
}
