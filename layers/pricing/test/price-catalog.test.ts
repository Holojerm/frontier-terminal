import { describe, expect, it } from 'vitest'

import { CATALOG_PAGE_SIZE, catalogPage, catalogRows } from '../app/utils/price-catalog'
import type { PriceRowView } from '../shared/types/prices'

const row = (provider: string, slug: string, input: number | null, output: number | null = input) =>
  ({
    entity_key: `${provider}:${slug}`,
    provider,
    model_slug: slug,
    input_per_mtok: input,
    output_per_mtok: output,
  }) as never as PriceRowView

const ROWS = [
  row('openai', 'a', 1),
  row('openai', 'b', null),
  row('anthropic', 'c', 3),
  row('anthropic', 'd', null, 15),
  row('xai', 'e', null),
]

const keys = (rows: PriceRowView[]) => rows.map((r) => r.model_slug)

describe('catalogRows', () => {
  it('keeps every row when neither filter is set', () => {
    expect(catalogRows(ROWS, { provider: 'all', pricedOnly: false })).toHaveLength(5)
  })

  it('drops a row only when it has neither an input nor an output price', () => {
    expect(keys(catalogRows(ROWS, { provider: 'all', pricedOnly: true }))).toEqual(['a', 'c', 'd'])
  })

  it('applies both filters together', () => {
    expect(keys(catalogRows(ROWS, { provider: 'openai', pricedOnly: true }))).toEqual(['a'])
    expect(keys(catalogRows(ROWS, { provider: 'openai', pricedOnly: false }))).toEqual(['a', 'b'])
    expect(catalogRows(ROWS, { provider: 'xai', pricedOnly: true })).toEqual([])
  })
})

describe('catalogPage', () => {
  const items = Array.from({ length: 60 }, (_, i) => i + 1)

  it('prints a bounded first page by default', () => {
    const p = catalogPage(items, 1)
    expect(p.rows).toHaveLength(CATALOG_PAGE_SIZE)
    expect(p).toMatchObject({ page: 1, pages: 3, first: 1, last: 25 })
  })

  it('reaches every row exactly once across its pages', () => {
    const { pages } = catalogPage(items, 1)
    const seen = Array.from({ length: pages }, (_, i) => catalogPage(items, i + 1).rows).flat()
    expect(seen).toEqual(items)
  })

  it('prints a short last page', () => {
    expect(catalogPage(items, 3)).toMatchObject({ rows: items.slice(50), first: 51, last: 60 })
  })

  it('clamps a page past either end to the nearest one', () => {
    expect(catalogPage(items, 9)).toMatchObject({ page: 3, first: 51, last: 60 })
    expect(catalogPage(items, 0)).toMatchObject({ page: 1, first: 1 })
    expect(catalogPage(items, Number.NaN)).toMatchObject({ page: 1, first: 1 })
  })

  it('is one page when the rows fit, and one empty page when there are none', () => {
    expect(catalogPage(items.slice(0, 25), 1)).toMatchObject({ pages: 1, first: 1, last: 25 })
    expect(catalogPage([], 4)).toEqual({ rows: [], page: 1, pages: 1, first: 0, last: 0 })
  })

  it('takes another page size', () => {
    expect(catalogPage(items, 2, 50)).toMatchObject({ pages: 2, first: 51, last: 60 })
  })
})
