// The payloads behind the compute panels read from recipes: Epoch AI's
// data-center power (/api/datacenters) and the utilization reads
// (/api/utilization: spot against on-demand, implied load, MLPerf rounds,
// revenue per megawatt). Every figure carries the URL it was read from and when.

import type { LabId, Prov, RecipeCitation } from '../../../core/shared/utils/terminal-types/common'

export interface DataCentersData {
  as_of: string | null
  snapshot: string | null
  sites: number
  total_mw: number
  total_h100e: number
  labs: {
    lab: LabId
    mw: number
    h100e: number
    sites: number
    /** Sites this lab shares with another named user: counted in full for each. */
    shared: number
    /** The site names, largest first. */
    names: string[]
  }[]
  /** Labs Epoch names only at #speculative: shown as a stated gap, never counted. */
  speculative_only: LabId[]
  /** Every site in the snapshot, largest first: Epoch's owner and users verbatim, confidence tags included. */
  site_list: {
    name: string
    mw: number
    h100e: number | null
    owner: string
    users: string
    country: string
  }[]
  source: RecipeCitation | null
  caveat: string
}

// ── Compute utilization: spot prices, implied load, revenue per MW ──────────

/** A pair of bounds. The site prints both ends and never a midpoint. */
export interface Bounds {
  low: number
  high: number
}

export interface SpotProviderRow extends Prov {
  provider: string
  provider_name: string
  gpu: string
  /** USD per GPU-hour: the median of the provider's rows that print a spot price. */
  on_demand: number
  spot: Bounds
  /** Spot ÷ on-demand, 0 to 1. Near 1 means little spare capacity is on offer. */
  ratio: Bounds
  rows: number
}

export interface ImpliedModelRow {
  /** The benchmark's own model name. */
  model: string
  results: number
  /** Tokens per second on one H100-equivalent: our division, not an MLPerf metric. */
  slowest: { per_h100e: number; result_id: string; accelerator: string }
  fastest: { per_h100e: number; result_id: string; accelerator: string }
  /** H100-equivalents the stated volume would keep busy at those two speeds. */
  h100e_busy: Bounds
  /** That load as a share of the fleet: fastest result over the fleet's 95th percentile, slowest over its 5th. */
  share: Bounds
}

/** One round's fastest result for a chip, benchmark and accelerator count. Unverified by MLCommons. */
export interface MlperfRoundResult {
  /** Tokens per second per accelerator: our division, not an MLPerf metric. */
  per_accelerator: number
  result_id: string
  submitter: string | null
  system: string | null
}

export interface MlperfRoundsRow {
  /** The chip as the newest round names it, without a system's "(x87)" count. */
  accelerator: string
  model: string
  /** The system size every round's result shares. */
  accelerators: number
  /** One entry per round in `rounds`, oldest first; null where that round has no such result. */
  results: (MlperfRoundResult | null)[]
  /** The newest result over the one before it, less one: 0.25 is 25% more tokens per second. */
  change: number
}

export interface UtilizationData {
  as_of: string | null
  spot: {
    providers: SpotProviderRow[]
    /** How many providers must print a spot price for one GPU before a combined figure is shown. */
    providers_needed: number
    /** Per GPU: the median across providers, or null below the quorum. */
    combined: { gpu: string; providers: number; ratio: Bounds | null }[]
    method: string
    caveat: string
  }
  implied: {
    lab: LabId
    tokens: {
      quarter: string
      period_end: string
      per_minute: number
      /** "nearly", "over", … as the release words it, or null for a bare figure. */
      qualifier: string | null
      /** The release's sentence, verbatim. */
      sentence: string
      source: RecipeCitation
    }
    history: { quarter: string; period_end: string; per_minute: number; qualifier: string | null }[]
    fleet: {
      label: string
      date: string
      h100e: { p5: number; median: number; p95: number }
      source: RecipeCitation
    }
    models: ImpliedModelRow[]
    /** Results left out because Epoch rates no H100-equivalent for their accelerator. */
    unrated_results: number
    benchmark: { round: string; footnote: string; source: RecipeCitation }
    chip_ratings: RecipeCitation
    method: string
    caveat: string
  } | null
  /** Every stored MLPerf round side by side; null until two rounds are stored. */
  benchmark_rounds: {
    /** Oldest first. */
    rounds: string[]
    rows: MlperfRoundsRow[]
    /** Chips in a stored round with no like-for-like result in another. */
    accelerators_left_out: number
    /** Results from systems that mix chips, which have no one chip to divide by. */
    mixed_results: number
    footnote: string
    sources: RecipeCitation[]
    method: string
  } | null
  coreweave: {
    quarters: {
      quarter: string
      period_end: string
      revenue_usd: number
      active_mw: number
      qualifier: string | null
      /** Revenue ÷ the average of active power at the quarter's start and end; null for the first quarter stored. */
      revenue_per_mw: number | null
    }[]
    /** The newest quarter's revenue as a share of what its power would bill at CoreWeave's list prices today. */
    floor: {
      quarter: string
      share: Bounds
      h100e_per_mw: number
      list_usd_per_h100e_hour: Bounds
    } | null
    sources: RecipeCitation[]
    method: string
    caveat: string
  } | null
  demand_shape: {
    window: { from: string; to: string }
    days: number
    mean_tokens: number
    peak_tokens: number
    peak_date: string
    /** Average day ÷ busiest day. */
    ratio: number
    source: Prov | null
    citation: string | null
    caveat: string
  } | null
}
