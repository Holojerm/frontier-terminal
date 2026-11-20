import type { Prov, Stamp } from './common'

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
    /** Per date, the median share across providers; null below `spot_providers_needed`. */
    spot_combined: (SpotShare | null)[]
    /** Each provider that has printed a spot price for this GPU; null on a date it printed none. */
    spot: { provider: string; provider_name: string; share: (SpotShare | null)[] }[]
  }[]
  /** How many providers must print a spot price for one GPU before a combined share is shown. */
  spot_providers_needed: number
  method: string
}

export interface GpuPricesData extends Stamp {
  medians: GpuMedianView[]
  history: GpuHistoryView
  prices: GpuPriceView[]
  /** Providers whose newest run failed: none of their prices count today. */
  failed: { provider: string; provider_name: string; detail: string }[]
  method: string
  caveat: string
}
