// The payloads behind the panels that show the thesis recipes audited on
// 2026-11-04 (layers/terminal/server/utils/terminal-recipe-views.ts): enterprise
// adoption, package downloads, coding-agent PRs, rate limits, posted pay,
// parents' filing facts and data-center power. Every figure carries the URL
// it was read from and when, like the lab panels.

import type { LabId, Prov } from './terminal-types'

export interface RecipeCitation extends Prov {
  recipe_id: string
  label: string
}

/** One ISO week (Monday to Sunday, UTC) of a daily count, summed. */
export interface AdoptionWeek {
  /** The Monday, YYYY-MM-DD. */
  week: string
  /** Days of the week on record; under 7 is `partial`, and `total` covers only those. */
  days: number
  total: number
  partial: boolean
}

export interface AgentPrWeek extends AdoptionWeek {
  /** Any day of the week was counted after the fact, from the PRs that still existed. */
  retrospective: boolean
}

export interface AdoptionData {
  as_of: string | null
  ramp: {
    /** Months, YYYY-MM-01, ascending. */
    months: string[]
    /** `overall` first, then each vendor Ramp reports, by its newest rate. */
    series: { key: string; label: string; lab: LabId | null; values: (number | null)[] }[]
    /** The day the newest release was first stored, and Ramp's own version key. */
    release_seen: string
    data_version: string | null
    source: RecipeCitation
  } | null
  downloads: {
    recipe_id: string
    lab: LabId
    registry: 'npm' | 'PyPI'
    package: string
    kind: 'sdk' | 'agent'
    /** Downloads over the newest 28 days on record, and the 28 before. */
    last_28d: number | null
    prior_28d: number | null
    through: string | null
    /** Every complete week on record, oldest first; the week still running is left out. */
    weekly: AdoptionWeek[]
    source: RecipeCitation | null
  }[]
  agent_prs: {
    recipe_id: string
    lab: LabId
    agent: string
    query: string
    days: { date: string; value: number }[]
    /** Every complete week on record, oldest first; the week still running is left out. */
    weekly: AgentPrWeek[]
    source: RecipeCitation | null
  }[]
  caveats: { ramp: string; downloads: string; agent_prs: string }
}

export interface LimitRow {
  model: string
  tier: string
  /** Metric → value; null is "none published". */
  values: Record<string, number | null>
  /** Text limits ("256 concurrent streams") where a page gives no number. */
  text: string | null
}

export interface LimitsData {
  as_of: string | null
  pages: {
    recipe_id: string
    lab: LabId
    covers: string
    metrics: string[]
    rows: LimitRow[]
    /** The newest snapshot, and the one before it when a change has been seen. */
    snapshot: string
    previous: string | null
    /** Limits whose value differs from the previous snapshot. */
    changed: number
    source: RecipeCitation
  }[]
  caveat: string
}

export interface PayCell {
  key: string
  label: string
  median: number
  p25: number
  p75: number
  n: number
  departments: readonly string[] | null
  /** The cell's median at the previous stored reading, when there is one. */
  previous: { date: string; median: number } | null
}

export interface PayData {
  as_of: string | null
  boards: {
    recipe_id: string
    lab: LabId
    date: string
    roles_on_board: number
    cells: PayCell[]
    source: RecipeCitation
  }[]
  caveat: string
}

export interface ParentFact {
  key: string
  label: string
  /** YYYY-MM-DD: the period end, or the instant. */
  date: string
  /** "3 months", "9 months", "instant". */
  span: string
  value: number | null
  unit: 'usd' | 'pure' | 'shares' | 'text'
  text: string | null
}

export interface ParentsData {
  as_of: string | null
  parents: {
    recipe_id: string
    lab: LabId
    parent: string
    member: string
    /** The newest period end in the filing. */
    period: string
    facts: ParentFact[]
    source: RecipeCitation
  }[]
  caveat: string
}

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

/** Ramp's and Epoch's vendor names → the terminal's labs. */
export const LAB_OF_NAME: Readonly<Record<string, LabId>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  xai: 'xai',
  spacexai: 'xai',
  'mistral-ai': 'mistral',
  mistral: 'mistral',
  google: 'google',
  'google-deepmind': 'google',
  meta: 'meta',
  deepseek: 'deepseek',
  alibaba: 'alibaba',
  'moonshot-ai': 'moonshot',
}

/** "EquityMethodInvestmentOwnershipPercentage" → "Equity method investment ownership percentage". */
export function humanizeConcept(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
  return words.charAt(0) + words.slice(1).toLowerCase()
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
