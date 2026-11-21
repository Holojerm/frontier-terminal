// The sources.yaml blocks every query's context carries beyond the source
// registry: one reader per block, run once per request by queryContext()
// (layers/core/server/utils/terminal-db.ts), which types QueryContext from this
// map. A domain whose queries read a block adds its reader here.

import { readFiledFactSources } from '#layers/core/server/utils/terminal-sources'
import { parseDerivedSourcesBlock } from '#layers/core/server/pipeline/derived'
import { DERIVED_FROM } from './derived'
import { parseRevenueFilersBlock } from '#layers/companies/server/pipeline/parsers/sec/revenue-filers'
import { parseCikWhitelistBlock } from '#layers/companies/server/pipeline/parsers/sec/whitelist'
import { parseDepartmentClusters } from '#layers/talent/server/utils/terminal-clusters'

export const QUERY_CONTEXT_BLOCKS = {
  /** department_clusters: the buildout signal's department terms. */
  clusters: parseDepartmentClusters,
  /** revenue_filers and cik_whitelist: which lab a filer's facts belong to. */
  revenueFilers: parseRevenueFilersBlock,
  whitelist: parseCikWhitelistBlock,
  /** derived_sources: the templates, for naming derived sources on the coverage panel. */
  derivedTemplates: (sourcesYaml: string) => parseDerivedSourcesBlock(sourcesYaml, DERIVED_FROM),
  /** filed_fact_sources: the hyperscalers the exposure series read. */
  filedFactSources: (sourcesYaml: string) =>
    readFiledFactSources(sourcesYaml, parseCikWhitelistBlock(sourcesYaml)),
} satisfies Record<string, (sourcesYaml: string) => unknown>

export type QueryContextBlocks = {
  [K in keyof typeof QUERY_CONTEXT_BLOCKS]: ReturnType<(typeof QUERY_CONTEXT_BLOCKS)[K]>
}
