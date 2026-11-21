// The model-release timeline: every SKU a vendor page started listing after
// that source's baseline (terminal-history.ts › releaseEvents).

import { and, eq, min } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { ReleasesData } from '../../shared/utils/terminal-types'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import {
  loadBaselineInstants,
  sourceIdForUrl,
  stampOf,
  type QueryContext,
} from '#layers/core/server/utils/terminal-db'
import { releaseEvents } from './terminal-history'

export async function queryReleases(db: PipelineDb, ctx: QueryContext): Promise<ReleasesData> {
  const [added, baseline, [earliest]] = await Promise.all([
    db
      .select()
      .from(tables.changes)
      .where(and(eq(tables.changes.entity_type, 'model'), eq(tables.changes.change_type, 'added'))),
    loadBaselineInstants(db),
    db.select({ at: min(tables.snapshots.fetched_at) }).from(tables.snapshots),
  ])
  const { rows, excluded_baseline } = releaseEvents(added, baseline, (url) =>
    sourceIdForUrl(url, ctx),
  )
  return { ...stampOf(ctx), rows, excluded_baseline, log_from: earliest?.at ?? null }
}
