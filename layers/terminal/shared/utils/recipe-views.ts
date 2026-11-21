// The payloads behind the panels that show the thesis recipes audited on
// 2026-11-04 (layers/terminal/server/utils/terminal-recipe-views.ts): enterprise
// adoption, package downloads, coding-agent PRs, posted pay, and parents'
// filing facts (rate limits are the pricing layer's shared/utils/limits.ts). Every figure carries the URL it was read from and
// when, like the lab panels.

import type { LabId, RecipeCitation } from './terminal-types'

/** One ISO week (Monday to Sunday, UTC) of a daily count, summed. */
export interface AdoptionWeek {
  /** The Monday, YYYY-MM-DD. */
  week: string
  /** Days of the week on record; under 7 is `partial`, and `total` covers only those. */
  days: number
  total: number
  partial: boolean
}

/** One ISO week of a derived download series: a ratio of sums over the days on record. */
export interface AdoptionRatioWeek {
  /** The Monday, YYYY-MM-DD. */
  week: string
  /** Days of the week the ratio rests on. */
  days: number
  value: number
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
    /** npm only: downloads ÷ the control index (download-series.ts), as a 28-day window and per week. */
    normalized_last_28d: number | null
    normalized_prior_28d: number | null
    normalized: AdoptionRatioWeek[]
    /** Core SDKs only: the share of the registry’s tracked core SDK downloads, last 28 days and per week. */
    share_28d: number | null
    share: AdoptionRatioWeek[]
    /** Stable ids of this package’s derived series (DOWNLOAD_SERIES), null where it has none. */
    series: { normalized: string | null; share: string | null }
    source: RecipeCitation | null
  }[]
  /** The non-AI npm packages the normalized series are divided by. */
  controls: {
    series_id: string
    base: { from: string; to: string }
    packages: { recipe_id: string; package: string; source: RecipeCitation | null }[]
    /** The index’s mean per week: 1.0 is the base weeks’ registry volume. */
    index: AdoptionRatioWeek[]
    /** Days npm reported zero for every package (stats outages), left out of every series. */
    outage_days: string[]
  }
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
  caveats: {
    ramp: string
    downloads: string
    normalized: string
    share: string
    agent_prs: string
  }
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

/** "EquityMethodInvestmentOwnershipPercentage" → "Equity method investment ownership percentage". */
export function humanizeConcept(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
  return words.charAt(0) + words.slice(1).toLowerCase()
}
