// Every kind of key a sources.yaml derived_sources template may be filled from:
// the app's composition root for derived sources. The mechanism is core's
// (layers/core/server/pipeline/derived.ts); each domain defines the kinds whose
// keys it holds and adds them here. Kept apart from lanes.ts so the query
// context (query-context.ts) reads the template names without every parser.

import { deriveFromTemplates, type DerivedKind } from '#layers/core/server/pipeline/derived'
import type { FetchSource } from '#layers/core/server/utils/pipeline-sources'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { COMPANY_DERIVED_KINDS } from '#layers/companies/server/pipeline/derived'
import { MODEL_DERIVED_KINDS } from '#layers/models/server/pipeline/derived'
import { PRICE_DERIVED_KINDS } from '#layers/pricing/server/pipeline/derived'

/** What derives sources from the store, in order (core's refresh and poll). */
export const DERIVED_SOURCES: readonly DerivedKind[] = [
  ...COMPANY_DERIVED_KINDS,
  ...PRICE_DERIVED_KINDS,
  ...MODEL_DERIVED_KINDS,
]

/** The `from` names a template may use. */
export const DERIVED_FROM: readonly string[] = DERIVED_SOURCES.map((k) => k.from)

/** Every derived source the store can name right now, in template order. */
export function deriveSources(db: PipelineDb, sourcesYaml: string): Promise<FetchSource[]> {
  return deriveFromTemplates(db, sourcesYaml, DERIVED_SOURCES)
}
