// The payload behind the rate-limit panels (layers/pricing/server/utils/terminal-limits.ts):
// the limits each lab publishes per model, tier and metric, the change since
// the snapshot before, and the Internet Archive copies of the same page. Every
// figure carries the URL it was read from and when.

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
    /** Internet Archive copies of the same page before the live record, or null where none read. */
    archived: ArchivedLimits | null
  }[]
  caveat: string
}

/** One limit that moved between two archived copies. */
export interface ArchivedLimitChange {
  model: string
  tier: string
  metric: string
  before: number
  after: number
  /** The copy before and the copy that shows the new value. */
  window_from: string
  window_to: string
  /** The copy that shows it. */
  source_url: string
}

export interface ArchivedLimits {
  copies: number
  from: string
  to: string
  changes: ArchivedLimitChange[]
}
