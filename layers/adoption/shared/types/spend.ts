import type { LabId, SourceRef, Stamp } from '../../../core/shared/types/common'
import type { DateWindow, RankingsData } from './rankings'

/** One ranked model in the share window, joined to a stored SKU when one matched. */
export interface SpendModel {
  model_permaslug: string
  tokens: number
  /** The SKU key the permaslug matched, or null — with `reason` saying why not. */
  matched_key: string | null
  /** free: an OpenRouter free-tier variant; unlisted: no stored SKU with that slug; unpriced: SKU listed without a published price. */
  reason: 'free' | 'unlisted' | 'unpriced' | null
  input_per_mtok: number | null
  output_per_mtok: number | null
  /** tokens × input list price, in USD; the floor of what those tokens would cost at list. */
  spend_low: number | null
  /** tokens × output list price, in USD; the ceiling. */
  spend_high: number | null
  price_source_url: string | null
  price_fetched_at: string | null
}

export interface SpendProviderView {
  provider: LabId
  display: string
  tokens: number
  /** Tokens on models that matched a priced SKU. */
  priced_tokens: number
  /** priced_tokens / tokens; null when the lab routed nothing in the window. */
  coverage: number | null
  spend_low: number
  spend_high: number
  /** This lab's spend_low over the tracked labs' spend_low, 0..1; null when nothing is priced. */
  share_low: number | null
  share_high: number | null
  /** This lab's tokens over the tracked labs' tokens in the same window, priced or not. Not
   * the rankings' share, which is of all OpenRouter tokens. */
  token_share: number | null
  /** This lab's priced tokens over the tracked labs' priced tokens: the like-for-like
   * denominator for share_low/high, which only count priced tokens. Null when nothing is priced. */
  priced_token_share: number | null
  models: SpendModel[]
}

export interface SpendData extends Stamp {
  /** Mirrors RankingsData.status. */
  status: 'ok' | 'not_configured' | 'no_rows'
  window: DateWindow | null
  providers: SpendProviderView[]
  totals: {
    tokens: number
    /** Tokens routed to models outside the tracked labs — not priced here, stated as the gap. */
    other_tokens: number
    priced_tokens: number
    spend_low: number
    spend_high: number
  }
  /** Labs with tokens in the window but no priced SKU matched: in the token share, out of the dollar share, and said so. */
  excluded: { provider: LabId; display: string; reason: string }[]
  /** The rankings feed's provenance, citation and caveat travel with the derivation. */
  rankings: Pick<RankingsData, 'provenance' | 'source' | 'meta'>
  /** The pricing sources the SKUs came from. */
  price_sources: SourceRef[]
  /** What this number is and is not, stated once. */
  caveat: string
}
