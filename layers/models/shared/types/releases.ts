/** A SKU first listed after a source's baseline: an `added` change on a model row. */
export interface ReleaseView extends Prov {
  change_id: string
  entity_key: string
  source_id: string
  provider: ProviderId
  model_slug: string
  tier: string | null
  context_window: string | null
  /** detected_at of the added change — when the listing was first seen. */
  first_seen_at: string
  input_per_mtok: number | null
  cached_input_per_mtok: number | null
  output_per_mtok: number | null
  notes: string | null
  /** Other sources that also listed the key (the two Anthropic pages both do). */
  also_listed_by: string[]
}

export interface ReleasesData extends Stamp {
  /** Newest first. */
  rows: ReleaseView[]
  /** Added rows dropped because they came from a source's first snapshot. */
  excluded_baseline: number
  /** Earliest snapshot in the store — before it, nothing could have been seen. */
  log_from: string | null
}
