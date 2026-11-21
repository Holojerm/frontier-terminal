// What every lane's parse reads beyond its own fetch: the app's composition
// root for the lane context, which the lane contract
// (layers/core/server/pipeline/lanes.ts › ParseContext) types itself from.
//
// LaneBlocks are the sources.yaml blocks the refresh builds once per tick
// (loadLaneBlocks); a lane names those it reads in Lane.reads, and they go into
// its context fingerprint. TICK_INPUTS are values a domain loads once per tick
// for its lanes: the refresh hands each to every parse and hashes the part a
// source's parse reads into that parse's input.

import type { TickInput } from '#layers/core/server/pipeline/lanes'
import type { Provider } from '#layers/core/server/utils/contracts'
import type { PendingFilers } from '#layers/companies/server/pipeline/parsers/sec/pending-filers'
import type { RevenueFilers } from '#layers/companies/server/pipeline/parsers/sec/revenue-filers'
import type { CikWhitelist } from '#layers/companies/server/pipeline/parsers/sec/whitelist'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { CLASS_MAP_INPUT } from '#layers/pricing/server/pipeline/class-map'
import { loadFilerBlocks } from '#layers/companies/server/pipeline/lane-blocks'

export interface LaneBlocks {
  whitelist: CikWhitelist
  /** sources.yaml revenue_filers: which lab a company-facts filer belongs to. */
  revenueFilers: RevenueFilers
  /** sources.yaml pending_filers: the labs whose CIK an S-1 hit may resolve. */
  pendingFilers: PendingFilers
  /** Labs already resolved (or tagged in the audited file): the resolver leaves them alone. */
  resolvedProviders: ReadonlySet<Provider>
}

/** Builds the tick's LaneBlocks: today only the SEC lanes read any. */
export const loadLaneBlocks: (db: PipelineDb, sourcesYaml: string) => Promise<LaneBlocks> =
  loadFilerBlocks

export const TICK_INPUTS = {
  /** The class map in effect this tick (layers/pricing/server/pipeline/class-map.ts); the seed when omitted. */
  classMap: CLASS_MAP_INPUT,
} as const

export type TickInputs = {
  [K in keyof typeof TICK_INPUTS]: (typeof TICK_INPUTS)[K] extends TickInput<infer T> ? T : never
}
