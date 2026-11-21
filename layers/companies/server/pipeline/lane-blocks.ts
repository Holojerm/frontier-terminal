import type { Provider } from '#layers/core/server/utils/contracts'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import type { LaneBlocks } from '#server/registries/lane-context'
import { resolvedFilers } from './derived'
import { parsePendingFilersBlock } from './parsers/sec/pending-filers'
import { parseRevenueFilersBlock } from './parsers/sec/revenue-filers'
import { parseCikWhitelistBlock } from './parsers/sec/whitelist'

/**
 * The SEC lanes' sources.yaml blocks for one tick (server/registries/lane-context.ts ›
 * loadLaneBlocks). A resolved lab joins the whitelist and the revenue filers
 * under its provider id, as an issuer; the audited file's entries win a
 * collision, so a lab tagged there is never re-resolved.
 */
export async function loadFilerBlocks(db: PipelineDb, sourcesYaml: string): Promise<LaneBlocks> {
  const whitelist = new Map(parseCikWhitelistBlock(sourcesYaml))
  const revenueFilers = new Map(parseRevenueFilersBlock(sourcesYaml))
  const pendingFilers = parsePendingFilersBlock(sourcesYaml)
  const resolvedProviders = new Set<Provider>()
  for (const [provider, filer] of revenueFilers) if (filer) resolvedProviders.add(provider)
  for (const filer of await resolvedFilers(db)) {
    if (resolvedProviders.has(filer.provider)) continue
    resolvedProviders.add(filer.provider)
    whitelist.set(filer.provider.toUpperCase(), filer.cik)
    revenueFilers.set(filer.provider, { ticker: filer.provider.toUpperCase(), relation: 'issuer' })
  }
  return { whitelist, revenueFilers, pendingFilers, resolvedProviders }
}
