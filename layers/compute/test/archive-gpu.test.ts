import { describe, expect, test } from 'vitest'

import {
  GPU_ARCHIVE_ERAS,
  GPU_ARCHIVE_GAPS,
  GPU_ARCHIVE_UNTIL,
  gpuEraById,
} from '../server/pipeline/archive/gpu-eras'
import { archiveRawKey } from '#layers/core/server/pipeline/archive/captures'
import { gpuRows } from '#layers/compute/server/pipeline/archive/rows'
import { lambdaArchivedRows } from '../server/pipeline/parsers/gpu/wayback-gpu'
import sourcesYaml from '~~/sources.yaml?raw'

// The archived GPU price pages' pure half: the era windows, the rules the
// rows enforce (a copy that prices nothing, or is cut short, is a skip with
// its reason), and the weekly median the read side draws. The golden tests
// over real captures are in pipeline/wayback-gpu.golden.test.ts.

const FETCHED = '2026-11-20T00:00:00.000Z'
const capture = (era: string, timestamp: string) => ({
  timestamp,
  original: gpuEraById(era)!.url,
  digest: timestamp,
})

const lambdaPage = (head: string, cells: string) =>
  `<html><body><table><tr><td>GPUs</td><td>VRAM per GPU</td>${head}</tr>` +
  `<tr><td>8x NVIDIA H100 SXM New</td><td>80 GB</td>${cells}</tr>` +
  `<tr><td>Reserved 8x NVIDIA H100 SXM</td><td>80 GB</td><td>$1.00 / hr</td></tr></table></body></html>`

describe('GPU eras', () => {
  test('every era is a window between 2023 and the first live read, none overlapping', () => {
    for (const era of GPU_ARCHIVE_ERAS) {
      expect(era.from < era.until, era.id).toBe(true)
      expect(era.from >= ARCHIVE_FROM, era.id).toBe(true)
      expect(era.until <= GPU_ARCHIVE_UNTIL, era.id).toBe(true)
    }
    expect(new Set(GPU_ARCHIVE_ERAS.map((e) => e.id)).size).toBe(GPU_ARCHIVE_ERAS.length)
    const byProvider = Map.groupBy(GPU_ARCHIVE_ERAS, (e) => e.provider)
    for (const [provider, eras] of byProvider) {
      const sorted = [...eras].sort((a, b) => (a.from < b.from ? -1 : 1))
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]!.from >= sorted[i - 1]!.until, provider).toBe(true)
      }
    }
  })

  test('every stated gap is a window of a provider the backfill reads', () => {
    const providers = new Set(GPU_ARCHIVE_ERAS.map((e) => e.provider))
    for (const g of GPU_ARCHIVE_GAPS) {
      expect(providers.has(g.provider), g.provider).toBe(true)
      expect(g.from < g.until).toBe(true)
      expect(g.reason.trim()).toBe(g.reason)
    }
  })

  test('the Archive’s terms come with the source, and its rights are not ours', () => {
    const gpu = readArchiveSources(sourcesYaml).find((s) => s.id === 'wayback-gpu')
    expect(gpu?.rights).toBe('not-cleared')
    expect(gpu?.terms).toMatch(/one request at a time/)
  })
})

describe('Lambda’s archived table', () => {
  test('a price column reads as of the capture: one not yet in effect is not a price', () => {
    const page = lambdaPage(
      '<td>2023 Price</td><td>2024 Price (effective 1/1/2024)</td>',
      '<td>$20.72 / hr</td><td>$27.92 / hr</td>',
    )
    expect(lambdaArchivedRows(page, '2023-12-26T00:00:00Z')[0]).toMatchObject({
      usd_per_gpu_hour: 2.59,
      instance_usd_per_hour: 20.72,
      gpus_per_instance: 8,
      label: 'NVIDIA H100 SXM',
      config: '8x',
    })
    expect(lambdaArchivedRows(page, '2024-01-02T00:00:00Z')[0]!.usd_per_gpu_hour).toBe(3.49)
  })

  test('a per-GPU price is not divided again, and a reserved row is skipped', () => {
    const rows = lambdaArchivedRows(
      lambdaPage('<td>PRICE / GPU / HR*</td>', '<td>$2.99 / GPU / hr</td>'),
      '2024-09-16T00:00:00Z',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ usd_per_gpu_hour: 2.99, instance_usd_per_hour: null })
  })
})

describe('archived GPU rows', () => {
  test('a copy with no on-demand H100 or B200 is skipped with the parser’s reason', () => {
    const page = lambdaPage('<td>Price</td>', '<td>Contact sales</td>').replace(/H100/g, 'A100')
    const out = gpuRows(
      gpuEraById('lambda-gpu-cloud-2023')!,
      capture('lambda-gpu-cloud-2023', '20230102213232'),
      page,
      page.length,
      FETCHED,
    )
    expect(out.prices).toEqual([])
    expect(out.capture).toMatchObject({ status: 'skipped', axis: 'gpu', rows: 0 })
    expect(out.capture.detail).toMatch(/on-demand H100 or B200/)
  })

  test('a copy cut short is skipped, and Google’s page ends at its footer', () => {
    const cut = lambdaPage('<td>Price</td>', '<td>$20.72 / hr</td>').replace('</html>', '')
    expect(
      gpuRows(
        gpuEraById('lambda-gpu-cloud-2023')!,
        capture('lambda-gpu-cloud-2023', '20231226173925'),
        cut,
        cut.length,
        FETCHED,
      ).capture.detail,
    ).toBe('capture is truncated: no closing </html>')
    const google = '<html><body><p>no table</p></section></footer>'
    expect(
      gpuRows(
        gpuEraById('google-cloud-accelerator-2026')!,
        capture('google-cloud-accelerator-2026', '20260921000000'),
        google,
        google.length,
        FETCHED,
      ).capture.detail,
    ).toBe('missing the GPU machine table')
  })

  test('an API era keeps its bytes as JSON', () => {
    expect(archiveRawKey(gpuEraById('oracle-price-list-2026')!, '20260812191351')).toBe(
      'archive/wayback/oracle-price-list-2026/20260812191351.json',
    )
    expect(archiveRawKey(gpuEraById('nebius-prices-2025')!, '20251020160326')).toMatch(/\.html$/)
  })
})

describe('the weekly archived median', () => {
  const at = (provider: string, day: string, value: number): ArchivedGpuCapture => ({
    provider,
    capture_id: `${provider}-era:${day.replace(/-/g, '')}000000`,
    captured_at: `${day}T00:00:00.000Z`,
    source_url: `https://web.archive.org/web/x/${provider}`,
    fetched_at: FETCHED,
    observations: [
      {
        provider,
        gpu: 'H100',
        counted: true,
        value,
        source_url: `https://web.archive.org/web/x/${provider}`,
        fetched_at: FETCHED,
      },
    ],
  })

  test('each week takes every provider’s newest copy, until it goes stale', () => {
    const series = archivedGpuSeries(
      [at('lambda', '2024-01-01', 2), at('nebius', '2024-01-03', 4), at('lambda', '2024-01-15', 3)],
      '2024-06-01',
    )
    expect(series.dates.slice(0, 4)).toEqual([
      '2024-01-01',
      '2024-01-08',
      '2024-01-15',
      '2024-01-22',
    ])
    const h100 = series.gpus.find((g) => g.gpu === 'H100')!
    // Week 1: Lambda only (Nebius's first copy is two days later). Then both, then Lambda's new price.
    expect(h100.median.slice(0, 3)).toEqual([2, 3, 3.5])
    expect(h100.providers.slice(0, 3)).toEqual([1, 2, 2])
    // Nebius's copy from 2024-01-03 drops out once it is more than the stale window old.
    const lastNebius = series.dates.findLastIndex(
      (d) => Date.parse(d) - Date.parse('2024-01-03') <= GPU_ARCHIVE_STALE_DAYS * 86_400_000,
    )
    expect(h100.providers[lastNebius]).toBe(2)
    expect(h100.providers[lastNebius + 1]).toBe(1)
    expect(series.gpus.find((g) => g.gpu === 'B200')!.median.every((m) => m === null)).toBe(true)
  })

  test('no copies, no dates', () => {
    expect(archivedGpuSeries([], '2026-11-01').dates).toEqual([])
  })
})
