import { describe, expect, test } from 'vitest'

import { GPU_ARCHIVE_ERAS, gpuEraById } from '../../server/pipeline/archive/gpu-eras'
import { gpuRows } from '#layers/compute/server/pipeline/archive/rows'
import { captureInstant, sameOriginal } from '#layers/core/server/pipeline/archive/wayback'
import { fixtureText, manifest, provenanceOf } from '#layers/core/test/pipeline/fixtures'

// Golden tests for the archived GPU price pages (archive/gpu-eras.ts): one
// Internet Archive capture per layout the live recipes don't read, trimmed as
// fixtures/manifest.json says (the trim gives the same rows as the raw
// capture). Each H100 price below was checked against the capture's text by
// hand, and its division where the page priced an instance.

const W = (name: string) => fixtureText(`fixtures/recipes/wayback/${name}`)

// era, timestamp, fixture, rows stored, { key: USD per GPU-hour }
const FIXTURES: readonly [string, string, string, number, Record<string, number>][] = [
  [
    'lambda-gpu-cloud-2023',
    '20231226173925',
    'lambda-gpu-cloud-2023-12.html',
    2,
    // "2023 Price" ($20.72 / hr for 8x) is in effect; "2024 Price (effective 1/1/2024)" is not yet.
    { 'h100:sxm:nvidia-h100-sxm:8:8x': 2.59, 'h100:pcie:nvidia-h100-pcie:1:1x': 1.99 },
  ],
  [
    'lambda-gpu-cloud-2023',
    '20240916060818',
    'lambda-gpu-cloud-2024-09.html',
    2,
    { 'h100:sxm:nvidia-h100-sxm:8:8x': 2.99, 'h100:pcie:nvidia-h100-pcie:1:1x': 2.49 },
  ],
  [
    'lambda-ai-gpu-cloud-2025',
    '20250528111542',
    'lambda-ai-gpu-cloud-2025-05.html',
    5,
    { 'h100:sxm:nvidia-h100-sxm:8:8x': 2.99, 'h100:sxm:nvidia-h100-sxm:1:1x': 3.29 },
  ],
  [
    'lambda-ai-pricing-2025',
    '20251011220942',
    'lambda-ai-pricing-2025-10.html',
    6,
    { 'h100:sxm:nvidia-h100-sxm:8:8x': 2.99, 'b200:sxm:nvidia-b200-sxm6:8:8x': 4.99 },
  ],
  [
    'coreweave-pricing-2025',
    '20250917194140',
    'coreweave-pricing-2025-09.html',
    2,
    // $49.24 an hour for 8 GPUs.
    { 'h100:hgx:nvidia-hgx-h100:8': 6.155 },
  ],
  [
    'nebius-ai-prices-2023',
    '20240805155823',
    'nebius-ai-prices-2024-08.html',
    1,
    { 'h100:sxm:h100-sxm5': 4.85 },
  ],
  [
    'nebius-prices-2024',
    '20250115165501',
    'nebius-prices-2025-01.html',
    2,
    // "8 × H100 SXM" at $23.60 a VM-hour.
    { 'h100:sxm:h100-sxm:1': 2.95, 'h100:sxm:h100-sxm:8': 2.95 },
  ],
  [
    'nebius-prices-2024',
    '20250322001211',
    'nebius-prices-2025-03.html',
    1,
    { 'h100:nvidia-h100-gpu': 2.95 },
  ],
  [
    'nebius-prices-2025',
    '20251020160326',
    'nebius-prices-2025-10.html',
    2,
    { 'h100:hgx:nvidia-hgx-h100': 2.95, 'b200:hgx:nvidia-hgx-b200': 5.5 },
  ],
  [
    'crusoe-pricing-2025',
    '20250929194310',
    'crusoe-pricing-2025-09.html',
    1,
    { 'h100:sxm:nvidia-h100-80gb-sxm': 3.9 },
  ],
  [
    'crusoe-pricing-2025b',
    '20260225204158',
    'crusoe-pricing-2026-02.html',
    1,
    // Keyed like the live recipe: the name and memory tag, no form factor.
    { 'h100:nvidia-h100-80gb': 3.9 },
  ],
  [
    'datacrunch-products-2023',
    '20241005191147',
    'datacrunch-products-2024-10.html',
    5,
    // $26.80 an hour for 8 GPUs.
    {
      'h100:sxm:h100-sxm5-80gb:8:8h100-80s-176v': 3.35,
      'h100:sxm:h100-sxm5-80gb:1:1h100-80s-30v': 3.35,
    },
  ],
  [
    'together-gpu-clusters-2026',
    '20260326031740',
    'together-gpu-clusters-2026-03.html',
    2,
    {
      'h100:hgx:nvidia-hgx-h100-sxm-80gb:gpu-clusters': 2.99,
      'b200:hgx:nvidia-hgx-b200:gpu-clusters': 5.5,
    },
  ],
]

function read(era: string, ts: string, name: string) {
  const e = gpuEraById(era)!
  const text = W(name)
  const prov = provenanceOf(`wayback-${era}-${ts}`)
  const original = prov.source_url.replace(/^https:\/\/web\.archive\.org\/web\/\d{14}id_\//, '')
  const capture = { timestamp: ts, original, digest: ts }
  return { e, prov, rows: gpuRows(e, capture, text, text.length, prov.fetched_at) }
}

describe('archived GPU price pages', () => {
  test.each(FIXTURES)('%s %s reads every on-demand row', (era, ts, name, n, prices) => {
    const { e, prov, rows } = read(era, ts, name)
    expect(rows.capture, rows.capture.detail ?? '').toMatchObject({
      status: 'parsed',
      axis: 'gpu',
      era,
      rows: n,
    })
    expect(sameOriginal(prov.source_url, e.url)).toBe(true)
    expect(rows.prices).toHaveLength(n)
    for (const [key, value] of Object.entries(prices)) {
      expect(rows.prices.find((r) => r.key === key)?.value, key).toBe(value)
    }
    for (const r of rows.prices) {
      expect(r).toMatchObject({
        provider: e.provider,
        captured_at: captureInstant(ts),
        basis: 'archived',
        source_url: prov.source_url,
        fetched_at: prov.fetched_at,
      })
    }
    expect(read(era, ts, name).rows).toEqual(rows)
  })

  test('every era with a parser of its own has a fixture', () => {
    const covered = new Set(FIXTURES.map(([era]) => era))
    // Eras read by a live recipe's extractor are covered by its fixture (fixtures/recipes/gpu-*).
    const own = GPU_ARCHIVE_ERAS.filter((e) => /ArchivedRows$/.test(e.parse.name))
    expect(own.length).toBeGreaterThan(0)
    for (const era of own) expect(covered.has(era.id), era.id).toBe(true)
    for (const [, , name] of FIXTURES) {
      expect(manifest.fixtures.some((f) => f.path === `fixtures/recipes/wayback/${name}`)).toBe(
        true,
      )
    }
  })
})
