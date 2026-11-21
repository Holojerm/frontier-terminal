import type { LabId, Prov, ProviderId, Stamp } from '../../../core/shared/types/common'
import type { SnapshotStamp, SourceRunStamp } from '../../../core/shared/types/coverage'

export interface ProviderShare {
  provider: ProviderId
  display: string
  /** Tokens routed in the share window. */
  tokens: number
  /** 0..1 of the window's total across every provider; null when the window is empty. */
  share: number | null
  prior_tokens: number
  prior_share: number | null
  /** share minus prior_share, in percentage points; null when either side is missing. */
  delta_pp: number | null
}

export interface TopModel extends Prov {
  provider: ProviderId
  model_permaslug: string
  /** Tokens in the share window. */
  tokens: number
  /** 0..1 of the provider's own window tokens. */
  share_of_provider: number | null
}

export interface ProviderTopModels {
  provider: LabId
  display: string
  models: TopModel[]
}

export interface RankingDay {
  date: string
  tokens: Record<ProviderId, number>
  total: number
}

/** One ISO week (Monday to Sunday, UTC) of the whole stored history. */
export interface RankingWeek {
  /** The week's Monday. */
  week: string
  /** First and last day present in the week; a partial week shares over the days it has. */
  from: string
  to: string
  /** Days present, 1..7. */
  days: number
  tokens: Record<ProviderId, number>
  total: number
  /** 0..1 of the week's total across every provider, `other` included, as ProviderShare.share. */
  share: Record<ProviderId, number | null>
}

export interface DateWindow {
  from: string
  to: string
}

export interface RankingsCoverage {
  /** Distinct UTC days in the store. */
  days: number
  first_date: string | null
  last_date: string | null
  /** The newest SHARE_WINDOW_DAYS days present, and the SHARE_WINDOW_DAYS before them. */
  window: DateWindow | null
  prior_window: DateWindow | null
}

export interface RankingsData extends Stamp {
  /** ok: rows exist. not_configured: the newest run was skipped for want of the key. no_rows: registered, nothing parsed yet. */
  status: 'ok' | 'not_configured' | 'no_rows'
  source: {
    source_id: string
    label: string
    url: string
    caveat: string | null
    license: string | null
    last_run: SourceRunStamp | null
    newest_snapshot: SnapshotStamp | null
  }
  /** The newest fetch of the feed — null only before the first successful fetch. */
  provenance: Prov | null
  meta: {
    /** OpenRouter's meta.as_of for the newest parsed payload. */
    as_of: string | null
    /** The required CC BY 4.0 citation, as_of filled in. */
    citation: string | null
    coverage: RankingsCoverage
  }
  shares: ProviderShare[]
  top_models: ProviderTopModels[]
  series: RankingDay[]
  /** Every stored week, oldest first: the long-run share per lab. */
  weekly: RankingWeek[]
}
