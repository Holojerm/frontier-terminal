// What a digest is built from: the theses payload and the week's rows. One
// reader for the Monday task and the public sample page, so the two never
// describe different weeks.

import { db } from '@nuxthub/db'
import { and, eq, gte } from 'drizzle-orm'

import sourcesYaml from 'raw:~~/sources.yaml'

import * as tables from '#server/db/schema'
import { DIGEST_DAYS, type DigestInput } from '../theses/digest'
import { terminalStamps } from './terminal-cache'
import { queryContext } from './terminal-db'
import { queryTheses } from './terminal-theses'

export async function loadDigestInput(
  now: Date,
): Promise<Pick<DigestInput, 'data' | 'changes' | 'failedRuns' | 'now'>> {
  const since = new Date(now.getTime() - DIGEST_DAYS * 86_400_000).toISOString()
  const [data, changes, failedRuns] = await Promise.all([
    queryTheses(
      db,
      queryContext(sourcesYaml, (await terminalStamps(db)).poll, () => now),
    ),
    db
      .select()
      .from(tables.claimStatusChanges)
      .where(gte(tables.claimStatusChanges.changed_at, since)),
    db
      .select({
        recipe_id: tables.recipeRuns.recipe_id,
        started_at: tables.recipeRuns.started_at,
        detail: tables.recipeRuns.detail,
      })
      .from(tables.recipeRuns)
      .where(and(eq(tables.recipeRuns.status, 'failed'), gte(tables.recipeRuns.started_at, since))),
  ])
  return { data, changes, failedRuns, now }
}
