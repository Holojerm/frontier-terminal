import { and, eq, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { derivedSourceId, type DerivedKind } from '#layers/core/server/pipeline/derived'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'

// The misalignment report pages derived from OpenAI's index (core's derived.ts
// has the mechanism): each report slug on openai-misalignment-reports fills the
// report-page template.

/** Report slugs on the OpenAI misalignment index, sorted. Notices link off-site and are not derived. */
export async function openAiMisalignmentReportSlugs(db: PipelineDb): Promise<string[]> {
  const kind = sql<string | null>`json_extract(${tables.entities.payload}, '$.kind')`
  const id = sql<string | null>`json_extract(${tables.entities.payload}, '$.entry_id')`
  const rows = await db
    .select({ id })
    .from(tables.entities)
    .where(
      and(
        eq(tables.entities.source_id, 'openai-misalignment-reports'),
        eq(tables.entities.entity_type, 'disclosure'),
        sql`${kind} = 'report'`,
      ),
    )
  return [
    ...new Set(
      rows.map((r) => r.id).filter((s): s is string => !!s && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)),
    ),
  ].sort()
}

/** The disclosures' template kind (server/registries/lanes.ts › DERIVED_SOURCES). */
export const MODEL_DERIVED_KINDS: readonly DerivedKind[] = [
  {
    from: 'openai-misalignment-report',
    load: async (db) => {
      const reports = await openAiMisalignmentReportSlugs(db)
      return (t) =>
        reports.map((slug) => ({
          source_id: derivedSourceId(t.id, slug),
          url: t.url.replace('{slug}', slug),
          ext: 'html',
        }))
    },
  },
]
