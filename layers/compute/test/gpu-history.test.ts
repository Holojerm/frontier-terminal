import { describe, expect, it } from 'vitest'

import { gpuMedian } from '../server/recipes/gpu-series'

const prov = { source_url: 'https://example.test/pricing', fetched_at: '2026-11-20T00:00:00Z' }

const read = (
  provider: string,
  date: string,
  value: number,
  spot: number | null = null,
  gpu: 'H100' | 'B200' = 'H100',
): StoredGpuRead => ({
  recipe_id: `gpu-${provider}`,
  date,
  provider,
  gpu,
  counted: true,
  value,
  spot_low: spot,
  spot_high: spot,
  ...prov,
})

const h100 = (h: ReturnType<typeof gpuHistory>) => h.gpus.find((g) => g.gpu === 'H100')!

describe('gpuHistory', () => {
  it('holds a page that did not change at its last stored price', () => {
    const h = gpuHistory(
      [
        read('lambda', '2026-11-02', 4),
        read('nebius', '2026-11-02', 6),
        read('crusoe', '2026-11-02', 8),
        // Only Lambda's page changed on the 9th.
        read('lambda', '2026-11-09', 7),
      ],
      null,
    )
    expect(h.dates).toEqual(['2026-11-02', '2026-11-09'])
    expect(h100(h).median).toEqual([6, 7])
    expect(h100(h).providers).toEqual([3, 3])
  })

  it('names each day a provider joined or left the median, and no other day', () => {
    const stored = [
      read('lambda', '2026-11-02', 4),
      read('nebius', '2026-11-02', 6),
      // Lambda's price moved on the 9th: a price move, not a change of set.
      read('lambda', '2026-11-09', 5),
      read('google', '2026-11-12', 11),
    ]
    // Nebius's page failed today, so the snapshot leaves it out.
    const today = [read('lambda', '2026-11-20', 5), read('google', '2026-11-20', 11)]
    const h = gpuHistory(stored, { date: '2026-11-20', observations: today })
    expect(h100(h).median).toEqual([5, 5.5, 6, 8])
    expect(h100(h).provider_changes).toEqual([
      { date: '2026-11-12', joined: ['Google Cloud'], left: [] },
      { date: '2026-11-20', joined: [], left: ['Nebius'] },
    ])
    expect(h.gpus.find((g) => g.gpu === 'B200')!.provider_changes).toEqual([])
  })

  it('ends on today’s read as the panels count it', () => {
    const stored = [
      read('lambda', '2026-11-02', 4),
      read('nebius', '2026-11-02', 6),
      read('lambda', '2026-11-20', 5),
    ]
    // Nebius's page failed today, so the snapshot leaves it out.
    const today = [read('lambda', '2026-11-20', 5, 2)]
    const h = gpuHistory(stored, { date: '2026-11-20', observations: today })
    expect(h.dates).toEqual(['2026-11-02', '2026-11-20'])
    expect(h100(h).median.at(-1)).toBe(gpuMedian('H100', today).median)
    expect(h100(h).providers).toEqual([2, 1])
    expect(h100(h).spot[0]!.share.at(-1)).toEqual(spotRead(today).providers[0]!.ratio)
  })

  it('adds today as its own point when no page changed today', () => {
    const stored = [read('lambda', '2026-11-02', 4)]
    const h = gpuHistory(stored, { date: '2026-11-20', observations: stored })
    expect(h.dates).toEqual(['2026-11-02', '2026-11-20'])
    expect(h100(h).median).toEqual([4, 4])
  })

  it('leaves a gap on the days a provider printed no spot price', () => {
    const h = gpuHistory(
      [read('coreweave', '2026-11-02', 10), read('coreweave', '2026-11-09', 10, 4)],
      null,
    )
    expect(h100(h).spot).toEqual([
      {
        provider: 'coreweave',
        provider_name: 'CoreWeave',
        share: [null, { low: 0.4, high: 0.4 }],
      },
    ])
    expect(h100(h).spot_combined).toEqual([null, null])
    expect(h.gpus.find((g) => g.gpu === 'B200')!.spot).toEqual([])
  })

  it('prints a combined share only from the quorum up', () => {
    const three = ['coreweave', 'microsoft', 'crusoe'].map((p) => read(p, '2026-11-02', 10, 4))
    const h = gpuHistory([...three, read('nebius', '2026-11-09', 10, 8)], null)
    expect(h.spot_providers_needed).toBe(4)
    expect(h100(h).spot_combined).toEqual([null, { low: 0.4, high: 0.4 }])
  })

  it('is empty with nothing stored', () => {
    const h = gpuHistory([], null)
    expect(h.dates).toEqual([])
    expect(h100(h)).toMatchObject({ median: [], providers: [], spot: [], spot_combined: [] })
  })
})
