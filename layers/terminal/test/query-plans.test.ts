import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { READ_RUN_STATUSES } from '../server/db/tables/columns'

// Two of these indexes SQLite uses only while a query spells its expression
// the way the index does: a partial index needs the query to repeat its WHERE, and
// an expression index needs the same expression with the same literal. Reword
// either side and the query still returns the right rows, from a full scan,
// with nothing failing. These read the plan off the migrated schema.

async function plan(statement: string): Promise<string> {
  const { results } = await env.DB.prepare(`explain query plan ${statement}`).all<{
    detail: string
  }>()
  return results.map((r) => r.detail).join('\n')
}

describe('queries that depend on how an index is spelled', () => {
  it('the newest read of a source seeks the partial index of runs that read their page', async () => {
    const detail = await plan(
      `select st.source_id, (select s2.fetched_at from source_runs r2 indexed by source_runs_read_idx
          join snapshots s2 on s2.id = r2.snapshot_id
          where r2.source_id = st.source_id and r2.status in ${READ_RUN_STATUSES}
          order by r2.started_at desc limit 1) as read_at
        from source_stats st`,
    )
    expect(detail).toContain('source_runs_read_idx (source_id=?)')
  })

  it('the newest ranking date and the window back from it seek the date expression index', async () => {
    const date = `json_extract("entities"."payload", '$.date')`
    const newest = await plan(
      `select max(${date}) from "entities" where "entities"."entity_type" = 'ranking'`,
    )
    expect(newest).toContain('entities_type_date_idx (entity_type=?)')
    const window = await plan(
      `select "payload" from "entities" where "entities"."entity_type" = 'ranking' and ${date} >= '2026-01-01'`,
    )
    expect(window).toContain('entities_type_date_idx (entity_type=? AND <expr>>?)')
  })

  it('one entity type of the change log is a seek, with or without a date range', async () => {
    const byType = await plan(`select * from "changes" where "changes"."entity_type" = 'model'`)
    expect(byType).toContain('changes_type_detected_idx (entity_type=?)')
    const ranged = await plan(
      `select * from "changes" where "changes"."entity_type" = 'job' and "changes"."detected_at" > '2026-01-01'`,
    )
    expect(ranged).toContain('changes_type_detected_idx (entity_type=? AND detected_at>?)')
  })
})
