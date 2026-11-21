import type { Stamp } from '#layers/core/shared/utils/terminal-types/common'
import type { TableCounts } from '#layers/core/shared/utils/terminal-types/coverage'
import type { AlertView } from './alerts'

/**
 * What moved. Counts come from the `changes` table, which is reproducible
 * from two snapshots — never from a re-read of the current state.
 */
export interface MovementSummary {
  /** Newest detected_at in the store; null when nothing has ever diffed. */
  latest_detected_at: string | null
  /** Start of the reported window: window_hours back from latest_detected_at. */
  window_from: string | null
  window_hours: number
  /** Changes inside that window, by axis. */
  recent: {
    pricing: number
    hiring: number
    sec: number
    incidents: number
    disclosures: number
    total: number
  }
  /** Every change ever recorded — the denominator for "quiet" claims. */
  total_changes: number
  /** Sources with snapshots at all. */
  sources_total: number
  /** Sources whose newest snapshot is the only one they have: nothing to diff yet. */
  sources_not_yet_compared: number
}

export interface OverviewData extends Stamp {
  movement: MovementSummary
  /** Newest alert-tier rows first (notable, critical), with their cited change rows. */
  alerts: AlertView[]
  alert_count: number
  /** Newest minor changes first (severity info) — what moved, low stakes. */
  info: AlertView[]
  info_count: number
  totals: TableCounts
  /** Newest read across every source: a fetch whose page was parsed into the store. */
  latest_fetched_at: string | null
}
