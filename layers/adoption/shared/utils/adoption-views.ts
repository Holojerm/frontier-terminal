// The payload behind the adoption panels (layers/adoption/server/utils/terminal-adoption.ts):
// enterprise adoption, package downloads and coding-agent PRs, read from the
// thesis recipes audited on 2026-11-04. Every figure carries the URL it was
// read from and when, like the lab panels.

import type { LabId, RecipeCitation } from '../../../core/shared/types/common'

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
