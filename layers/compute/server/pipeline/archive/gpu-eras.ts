// The eras of each GPU provider's price page, as the Internet Archive holds
// them: which URL the provider priced its on-demand GPUs on, over which
// window, and which parser reads that layout. Windows are half-open
// [from, until) and never overlap within a provider, so the provider's
// prices at an instant are the newest parsed capture of the one era
// covering it. Every era ends by the day its live recipe began
// (GPU_ARCHIVE_UNTIL): from then on recipe_observations is the record.
//
// How each window was found: the CDX listing of each candidate URL, and a
// read of the captures on either side of each layout change
// (docs/source-audit.md › "Addendum, 2026-11-20: Internet Archive (GPU rental prices)"). A stretch
// with no readable copy is stated in GPU_ARCHIVE_GAPS.

import type { CompanyId } from '../../../../core/shared/utils/companies'
import { oracleRows } from '../../recipes/gpu-apis'
import {
  coreweaveArchivedRows,
  crusoeListArchivedRows,
  crusoeTableArchivedRows,
  datacrunchProductsArchivedRows,
  lambdaArchivedRows,
  nebiusAiArchivedRows,
  nebiusGpuHourArchivedRows,
  nebiusTableArchivedRows,
  togetherClustersArchivedRows,
} from '../parsers/gpu/wayback-gpu'
import type { GpuRow } from '../../recipes/gpu-prices'
import {
  coreweaveRows,
  crusoeRows,
  digitaloceanRows,
  googleCloudRows,
  lambdaRows,
  nebiusRows,
  verdaRows,
} from '../../recipes/gpu-pages'
import { ARCHIVE_FROM } from '../../../../core/server/utils/archive-floor'

export type GpuArchiveProvider = Extract<
  CompanyId,
  | 'lambda'
  | 'coreweave'
  | 'nebius'
  | 'crusoe'
  | 'together'
  | 'digitalocean'
  | 'verda'
  | 'oracle'
  | 'google'
>

/**
 * The first day of the live gpu-* recipes (sources.yaml › recipe_sources).
 * Google Cloud's recipe began later (2026-11-20); its archived copies stop
 * here too, so the series ends on one day for every provider.
 */
export const GPU_ARCHIVE_UNTIL = '2026-11-01T00:00:00.000Z'

export interface GpuEra {
  id: string
  provider: GpuArchiveProvider
  /** The page as the provider published it; the CDX key. */
  url: string
  from: string
  until: string
  /** What the page looked like, for the audit and the reach note. */
  shape: string
  /** capturedAt: a page that prints a price with its effective date is read as of the capture. */
  parse: (text: string, capturedAt: string) => GpuRow[]
  /** The capture's format, when its URL doesn't say (archiveRawKey). */
  ext?: 'html' | 'json'
  /**
   * What the end of a whole copy carries, when it isn't </html>: Google's
   * page omits the closing tags its HTML allows it to drop.
   */
  end?: RegExp
}

const live =
  (rows: (body: string) => GpuRow[]) =>
  (text: string): GpuRow[] =>
    rows(text)

const until = GPU_ARCHIVE_UNTIL

export const GPU_ARCHIVE_ERAS: readonly GpuEra[] = [
  {
    id: 'lambda-gpu-cloud-2023',
    provider: 'lambda',
    url: 'https://lambdalabs.com/service/gpu-cloud',
    from: ARCHIVE_FROM,
    until: '2025-03-28T00:00:00.000Z',
    shape:
      'lambdalabs.com/service/gpu-cloud: an on-demand table per instance, per instance-hour, then per GPU-hour from late 2024',
    parse: lambdaArchivedRows,
  },
  {
    id: 'lambda-ai-gpu-cloud-2025',
    provider: 'lambda',
    url: 'https://lambda.ai/service/gpu-cloud',
    from: '2025-03-28T00:00:00.000Z',
    until: '2025-06-04T00:00:00.000Z',
    shape: 'lambda.ai/service/gpu-cloud: the same on-demand table, per GPU-hour',
    parse: lambdaArchivedRows,
  },
  {
    id: 'lambda-ai-pricing-2025',
    provider: 'lambda',
    url: 'https://lambda.ai/pricing',
    from: '2025-06-04T00:00:00.000Z',
    until: '2025-11-15T00:00:00.000Z',
    shape: 'lambda.ai/pricing: one on-demand table per GPU-count tab, per GPU-hour',
    parse: lambdaArchivedRows,
  },
  {
    id: 'lambda-ai-pricing-2026',
    provider: 'lambda',
    url: 'https://lambda.ai/pricing',
    from: '2025-11-15T00:00:00.000Z',
    until,
    shape: 'lambda.ai/pricing: "Instances pricing", the layout the live recipe reads',
    parse: live(lambdaRows),
  },
  {
    id: 'coreweave-pricing-2025',
    provider: 'coreweave',
    url: 'https://www.coreweave.com/pricing',
    from: '2025-01-01T00:00:00.000Z',
    until: '2026-04-01T00:00:00.000Z',
    shape:
      'coreweave.com/pricing: Webflow lists, one item per instance with "Instance Price (Per Hour)"',
    parse: coreweaveArchivedRows,
  },
  {
    id: 'coreweave-pricing-2026',
    provider: 'coreweave',
    url: 'https://www.coreweave.com/pricing',
    from: '2026-04-01T00:00:00.000Z',
    until,
    shape:
      'coreweave.com/pricing: on-demand and spot per instance, the layout the live recipe reads',
    parse: live(coreweaveRows),
  },
  {
    id: 'nebius-ai-prices-2023',
    provider: 'nebius',
    url: 'https://nebius.ai/prices',
    from: '2023-11-01T00:00:00.000Z',
    until: '2024-11-01T00:00:00.000Z',
    shape: 'nebius.ai/prices: "GPU type: H100 SXM5. PAYG price – $4.85/h", per GPU-hour',
    parse: nebiusAiArchivedRows,
  },
  {
    id: 'nebius-prices-2024',
    provider: 'nebius',
    url: 'https://nebius.com/prices',
    from: '2024-11-01T00:00:00.000Z',
    until: '2025-07-01T00:00:00.000Z',
    shape:
      'nebius.com/prices: a GPU price table, per VM-hour with an on-demand column, then per GPU-hour',
    parse: nebiusTableArchivedRows,
  },
  {
    id: 'nebius-prices-2025',
    provider: 'nebius',
    url: 'https://nebius.com/prices',
    from: '2025-07-01T00:00:00.000Z',
    until: '2026-04-01T00:00:00.000Z',
    shape: 'nebius.com/prices: "NVIDIA GPU Instances", one "Price per GPU-hour" column',
    parse: nebiusGpuHourArchivedRows,
  },
  {
    id: 'nebius-prices-2026',
    provider: 'nebius',
    url: 'https://nebius.com/prices',
    from: '2026-04-01T00:00:00.000Z',
    until,
    shape:
      'nebius.com/prices: "NVIDIA GPU Instances" with an "On-demand, GPU-hour" column, read live',
    parse: live(nebiusRows),
  },
  {
    id: 'crusoe-pricing-2025',
    provider: 'crusoe',
    url: 'https://www.crusoe.ai/cloud/pricing',
    from: '2024-05-01T00:00:00.000Z',
    until: '2025-11-01T00:00:00.000Z',
    shape: 'crusoe.ai/cloud/pricing: a "GPU Pricing" table, on-demand per GPU-hour',
    parse: crusoeTableArchivedRows,
  },
  {
    id: 'crusoe-pricing-2025b',
    provider: 'crusoe',
    url: 'https://www.crusoe.ai/cloud/pricing',
    from: '2025-11-01T00:00:00.000Z',
    until: '2026-10-26T00:00:00.000Z',
    shape: 'crusoe.ai/cloud/pricing: a Webflow list, "GPU model, On-demand, Current spot"',
    parse: crusoeListArchivedRows,
  },
  {
    id: 'crusoe-pricing-2026',
    provider: 'crusoe',
    url: 'https://www.crusoe.ai/cloud/pricing',
    from: '2026-10-26T00:00:00.000Z',
    until,
    shape: 'crusoe.ai/cloud/pricing: "GPU instances pricing", the layout the live recipe reads',
    parse: live(crusoeRows),
  },
  {
    id: 'together-gpu-clusters-2026',
    provider: 'together',
    url: 'https://www.together.ai/gpu-clusters',
    from: '2026-02-01T00:00:00.000Z',
    until,
    shape:
      'together.ai/gpu-clusters: one card per GPU cluster, on-demand and reserved per GPU-hour',
    parse: togetherClustersArchivedRows,
  },
  {
    id: 'digitalocean-gpu-droplets-2024',
    provider: 'digitalocean',
    url: 'https://www.digitalocean.com/pricing/gpu-droplets',
    from: '2024-10-01T00:00:00.000Z',
    until,
    shape: 'digitalocean.com/pricing/gpu-droplets: a pricing card per GPU, read by the live recipe',
    parse: live(digitaloceanRows),
  },
  {
    id: 'datacrunch-products-2023',
    provider: 'verda',
    url: 'https://datacrunch.io/products',
    from: ARCHIVE_FROM,
    until: '2025-09-01T00:00:00.000Z',
    shape:
      'datacrunch.io/products: a table per GPU family, one row per instance, on-demand per instance-hour',
    parse: datacrunchProductsArchivedRows,
  },
  {
    id: 'verda-pricing-2026',
    provider: 'verda',
    url: 'https://verda.com/pricing',
    from: '2026-07-01T00:00:00.000Z',
    until,
    shape: 'verda.com/pricing: the on-demand "GPU instances" table the live recipe reads',
    parse: live(verdaRows),
  },
  {
    id: 'oracle-price-list-2026',
    provider: 'oracle',
    url: 'https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD',
    from: '2026-08-01T00:00:00.000Z',
    until,
    shape: 'Oracle’s Cloud Price List API in USD, the answer the live recipe reads',
    parse: live(oracleRows),
    ext: 'json',
  },
  {
    id: 'google-cloud-accelerator-2026',
    provider: 'google',
    url: 'https://cloud.google.com/products/compute/pricing/accelerator-optimized',
    from: '2026-03-01T00:00:00.000Z',
    until,
    shape:
      'cloud.google.com accelerator-optimized pricing: the GPU machine table for one region, read by the live recipe',
    parse: live(googleCloudRows),
    end: /<\/footer>/i,
  },
]

/** Stretches with no readable archived price, and why. Printed on /compute and in the audit. */
export const GPU_ARCHIVE_GAPS: readonly {
  provider: GpuArchiveProvider
  from: string
  until: string
  reason: string
}[] = [
  {
    provider: 'lambda',
    from: '2023-01-01',
    until: '2023-05-12',
    reason:
      'Until May 2023 the on-demand table on lambdalabs.com listed no H100. Its first H100 row (1x H100 PCIe) is on the copy of 2023-05-12.',
  },
  {
    provider: 'coreweave',
    from: '2023-01-01',
    until: '2025-01-01',
    reason:
      'Until the end of 2024 CoreWeave priced each GPU as a component (HGX H100 at $4.76 an hour), with vCPUs and RAM billed on top, on coreweave.com/gpu-cloud-pricing. The live page prices whole instances, so the component price isn’t the same number, and we don’t add up a configuration to make one.',
  },
  {
    provider: 'nebius',
    from: '2023-01-01',
    until: '2023-11-01',
    reason: 'The Archive’s first copy of nebius.ai/prices is from 2023-11-01.',
  },
  {
    provider: 'nebius',
    from: '2024-09-15',
    until: '2024-11-15',
    reason:
      'Nebius moved its price page from nebius.ai to nebius.com in autumn 2024. The Archive’s last copy of the old page is from 2024-09-15 and its first of the new one from 2024-11-15.',
  },
  {
    provider: 'crusoe',
    from: '2023-01-01',
    until: '2025-04-03',
    reason:
      'The Archive’s first copy of Crusoe’s price page is from May 2024, and until April 2025 it priced no H100 on demand (A100, A40 and L40S only).',
  },
  {
    provider: 'together',
    from: '2023-01-01',
    until: '2026-03-08',
    reason:
      'Until March 2026 Together’s pages priced the H100 only as a dedicated inference endpoint (per minute, later per hour), a product the live recipe leaves out, or listed clusters with no price. together.ai/gpu-clusters printed on-demand cluster prices from March 2026.',
  },
  {
    provider: 'digitalocean',
    from: '2023-01-01',
    until: '2024-10-20',
    reason:
      'DigitalOcean launched GPU Droplets in October 2024. Its first copy (2024-10-07) prints two H100 prices per GPU-hour without saying which is on demand. The “On-Demand Price” label is on the copy of 2024-10-20.',
  },
  {
    provider: 'verda',
    from: '2023-01-01',
    until: '2023-09-23',
    reason:
      'Verda was DataCrunch until 2025. Until September 2023 datacrunch.io/products listed no H100 instance.',
  },
  {
    provider: 'verda',
    from: '2025-09-01',
    until: '2026-07-01',
    reason:
      'The Archive’s last copy of datacrunch.io/products is from August 2025 and its first of verda.com/pricing from July 2026. datacrunch.io’s home page shows a price calculator with no on-demand label, which we don’t read.',
  },
  {
    provider: 'oracle',
    from: '2023-01-01',
    until: '2026-08-12',
    reason:
      'The Archive holds four copies of the Price List API answer the live recipe reads, the first from 2026-08-12.',
  },
  {
    provider: 'google',
    from: '2023-01-01',
    until: '2026-09-21',
    reason:
      'The Archive’s copies of Google Cloud’s accelerator-optimized pricing page start on 2026-03-19. Until September 2026 they hold no GPU machine table, or end before the page does. Its live recipe began on 2026-11-20, and the archived copies stop at 2026-11-01 like every other provider’s.',
  },
]

/** Live GPU sources whose archived pages are not read, and why. */
export const GPU_ARCHIVE_NOT_COVERED: readonly { provider: string; reason: string }[] = [
  {
    provider: 'microsoft',
    reason:
      'Azure’s prices come from a filtered query to its Retail Prices API, and the Archive holds no copy of that query.',
  },
]

export function gpuEraById(id: string): GpuEra | null {
  return GPU_ARCHIVE_ERAS.find((e) => e.id === id) ?? null
}
