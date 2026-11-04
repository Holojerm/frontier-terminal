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
    source: RecipeCitation | null
  }[]
  agent_prs: {
    recipe_id: string
    lab: LabId
    agent: string
    query: string
    days: { date: string; value: number }[]
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
