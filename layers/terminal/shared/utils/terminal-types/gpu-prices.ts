import type { Prov, Stamp } from '#layers/core/shared/utils/terminal-types/common'

/** One published on-demand price, normalized to USD per GPU-hour (layers/terminal/server/theses/recipes/gpu-prices.ts). */
export interface GpuPriceView extends Prov {
  provider: string
  provider_name: string
  key: string
  gpu: 'H100' | 'B200'
  /** As printed: SXM, HGX, PCIe, NVL, or null when the page names none. */
  form_factor: string | null
  /** false for PCIe and NVL cards: kept, but not in the median. */
  counted: boolean
  label: string
  usd_per_gpu_hour: number
  gpus_per_instance: number | null
  instance_usd_per_hour: number | null
  region: string | null
  config: string | null
}

export interface GpuMedianView {
  gpu: 'H100' | 'B200'
  /** Median of the provider values; null with no provider priced. */
  median: number | null
  /** Each provider once, at the median of its own counted rows. */
  providers: (Prov & {
    provider: string
    provider_name: string
    usd_per_gpu_hour: number
    rows: number
  })[]
}

/** A spot price ÷ the on-demand price for the same instance, 0 to 1, at the two ends a page prints. */
export interface SpotShare {
  low: number
  high: number
}

/** The medians and spot shares as they stood on each day a provider's page changed. */
export interface GpuHistoryView {
  /** YYYY-MM-DD, ascending: each day a page changed, then the day of the newest read. */
  dates: string[]
  gpus: {
    gpu: 'H100' | 'B200'
    /** Per date, the median across providers in USD per GPU-hour; null with none priced. */
    median: (number | null)[]
    /** Per date, the providers the median counts. A change here moves it with no price moving. */
    providers: number[]
    /** Each date the set of providers counted changed from the date before, by display name. */
    provider_changes: { date: string; joined: string[]; left: string[] }[]
    /** Per date, the median share across providers; null below `spot_providers_needed`. */
    spot_combined: (SpotShare | null)[]
    /** Each provider that has printed a spot price for this GPU; null on a date it printed none. */
    spot: { provider: string; provider_name: string; share: (SpotShare | null)[] }[]
  }[]
  /** How many providers must print a spot price for one GPU before a combined share is shown. */
  spot_providers_needed: number
  method: string
}

/**
 * One Internet Archive copy of a provider's price page, read into the
 * provider's own price per GPU: the median of its counted rows, as the live
 * median counts it. `at` is when the Archive saw the page (event time);
 * fetched_at is when we read the copy back, long after.
 */
export interface ArchivedGpuPoint extends Prov {
  at: string
  basis: 'archived'
  /** wayback:<era>, the page and layout the copy belongs to (archive/gpu-eras.ts). */
  source_id: string
  /** USD per GPU-hour; null where the copy priced no counted row of that GPU. */
  h100: number | null
  b200: number | null
}

/** The price history from before the live recipes began, read from the Internet Archive. */
export interface GpuArchiveView {
  /** YYYY-MM-DD, ascending: one a week, from the first copy we read to the day before the live record. */
  dates: string[]
  gpus: {
    gpu: 'H100' | 'B200'
    /** Per date, the median across providers with a copy that week or the weeks just before; null with none. */
    median: (number | null)[]
    providers: number[]
  }[]
  /** Each provider's copies we could read, oldest first. */
  providers: {
    provider: string
    provider_name: string
    points: ArchivedGpuPoint[]
    /** Copies the backfill considered and couldn't read (archive_captures, axis gpu). */
    skipped: number
  }[]
  /** Stretches with no readable copy, and why. */
  gaps: { provider: string; provider_name: string; from: string; until: string; reason: string }[]
  /** Live providers whose archived pages we don't read, and why. */
  not_covered: { provider: string; provider_name: string; reason: string }[]
  /** The live record starts here (YYYY-MM-DD); the archived series ends the day before. */
  live_from: string
  method: string
}

export interface GpuPricesData extends Stamp {
  medians: GpuMedianView[]
  history: GpuHistoryView
  /** Null until the backfill (scripts/wayback-backfill.ts --axis gpu) has run. */
  archived: GpuArchiveView | null
  prices: GpuPriceView[]
  /** Providers whose newest run failed: none of their prices count today. */
  failed: { provider: string; provider_name: string; detail: string }[]
  method: string
  caveat: string
}
