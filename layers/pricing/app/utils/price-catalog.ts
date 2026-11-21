// The catalog's view: the rows its two filters leave, and the page of them the table prints.
// Every priced row in one table made /prices 49,000px tall, and 160,000px on a phone.

/** A phone stacks each row to about 280px, so a page of 25 is about 7,000px there. */
export const CATALOG_PAGE_SIZE = 25

export interface CatalogFilter {
  /** A lab id, or `all`. */
  provider: string
  /** Drop rows that state neither an input nor an output price. */
  pricedOnly: boolean
}

export function catalogRows(rows: PriceRowView[], filter: CatalogFilter): PriceRowView[] {
  return rows.filter((r) => {
    if (filter.provider !== 'all' && r.provider !== filter.provider) return false
    if (filter.pricedOnly && r.input_per_mtok === null && r.output_per_mtok === null) return false
    return true
  })
}

export interface CatalogPage<T> {
  rows: T[]
  /** The page printed, 1-based: the one asked for, or the nearest that exists. */
  page: number
  pages: number
  /** 1-based positions of the first and last row printed; both 0 when there are no rows. */
  first: number
  last: number
}

/**
 * One page of `rows`. A page past the end prints the last one, since a filter can shorten
 * the list under a reader who is already on page 9.
 */
export function catalogPage<T>(rows: T[], page: number, size = CATALOG_PAGE_SIZE): CatalogPage<T> {
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const at = Math.min(Math.max(1, Math.trunc(page) || 1), pages)
  const start = (at - 1) * size
  const slice = rows.slice(start, start + size)
  return {
    rows: slice,
    page: at,
    pages,
    first: slice.length ? start + 1 : 0,
    last: start + slice.length,
  }
}
