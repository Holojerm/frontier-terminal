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

export interface GpuPricesData extends Stamp {
  medians: GpuMedianView[]
  prices: GpuPriceView[]
  /** Providers whose newest run failed: none of their prices count today. */
  failed: { provider: string; provider_name: string; detail: string }[]
  method: string
  caveat: string
}
