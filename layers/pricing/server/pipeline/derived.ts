import { and, eq, like, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { Provider } from '#layers/core/server/pipeline/contracts'
import { derivedSourceId, type DerivedKind } from '#layers/core/server/pipeline/derived'
import type { PipelineDb } from '#layers/core/server/pipeline/store'

// The model pages derived from the price lists (core's derived.ts has the
// mechanism): a priced OpenAI model slug from openai-pricing-md and a priced
// Google model slug from google-pricing-html each fill a model-page template.

/** Priced slugs on one pricing page's Standard tier, sorted. OpenAI's Standard rows carry tier null; Google's say "standard". */
async function pricedSlugs(
  db: PipelineDb,
  sourceId: string,
  provider: Provider,
  standardTier: string | null,
): Promise<string[]> {
  const slug = sql<string | null>`json_extract(${tables.entities.payload}, '$.model_slug')`
  const tier = sql<string | null>`json_extract(${tables.entities.payload}, '$.tier')`
  const input = sql<number | null>`json_extract(${tables.entities.payload}, '$.input_per_mtok')`
  const rows = await db
    .select({ slug })
    .from(tables.entities)
    .where(
      and(
        eq(tables.entities.source_id, sourceId),
        eq(tables.entities.entity_type, 'model'),
        standardTier === null ? sql`${tier} IS NULL` : sql`${tier} = ${standardTier}`,
        sql`${input} IS NOT NULL`,
        like(tables.entities.entity_key, `model:${provider}:%`),
      ),
    )
  return [
    ...new Set(rows.map((r) => r.slug).filter((s): s is string => !!s && /^[a-z0-9.-]+$/.test(s))),
  ].sort()
}

/** Priced Standard-tier slugs on the OpenAI pricing page, sorted. */
export const openAiPricedSlugs = (db: PipelineDb) =>
  pricedSlugs(db, 'openai-pricing-md', 'openai', null)

/** Priced Standard-tier slugs on the Google pricing page, sorted. */
export const googlePricedSlugs = (db: PipelineDb) =>
  pricedSlugs(db, 'google-pricing-html', 'google', 'standard')

const modelPages = (slugsOf: (db: PipelineDb) => Promise<string[]>) => async (db: PipelineDb) => {
  const slugs = await slugsOf(db)
  return (t: { id: string; url: string }) =>
    slugs.map((slug) => ({
      source_id: derivedSourceId(t.id, slug),
      url: t.url.replace('{slug}', slug),
      ext: 'md',
    }))
}

/** The price lists' template kinds, in the order server/registries/lanes.ts lists them. */
export const PRICE_DERIVED_KINDS: readonly DerivedKind[] = [
  { from: 'openai-priced-model', load: modelPages(openAiPricedSlugs) },
  { from: 'google-priced-model', load: modelPages(googlePricedSlugs) },
]
