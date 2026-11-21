// List prices: the catalog and one SKU’s history. First listings are the
// shell's (layers/terminal/server/mcp/releases.ts), registered right after.

import { z } from 'zod'
import { queryPriceHistory, queryPrices } from '../utils/terminal-prices'
import {
  ProviderSchema,
  SkuKeySchema,
  json,
  failure,
  READ_ONLY,
  AsOfSchema,
  asOfErrors,
  PROVENANCE,
  type McpKit,
} from '#layers/core/server/mcp/kit'

export function registerPriceTools({ server, deps, read }: McpKit): void {
  server.registerTool(
    'get_prices',
    {
      title: 'API prices',
      description:
        'The API price catalog: one row per SKU key (provider + model + tier) at its newest revision, in USD per million tokens ' +
        '(input_per_mtok, cached_input_per_mtok, output_per_mtok; null = the vendor publishes no figure), plus delta vs. the previous revision ' +
        'and removed=true for a delisted SKU. matrix is the like-for-like view: one flagship / balanced / economy cell per provider on the ' +
        'standard tier, each citing the vendor sentence (basis) that justifies the mapping, or a stated gap. ' +
        'OpenAI prices come from its pricing.md (Standard / Batch / Flex / Fast tiers, long-context bands as their own tiers); its catalog page prints none. ' +
        'context_window_source is set when the window comes from another page than the row cites (Google prints windows on its model pages, not its pricing page). ' +
        'cross_check is OpenRouter: snapshotted as a drift check ' +
        'on the vendor pages, never a price of record. Optional provider filter narrows rows and matrix to one lab. ' +
        'reach says how far each lab’s price history goes back. An as_of before our first fetch is answered from the Internet Archive’s ' +
        'captures of each lab’s own pricing page (source_id wayback:<era>, point_in_time says which capture), with an empty matrix. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional(), as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ provider, as_of }) =>
      asOfErrors(async () => {
        const prices = await read(
          'prices',
          as_of,
          (ctx) => queryPrices(deps.db, ctx),
          '',
          'pricing',
        )
        if (!provider) return json(prices)
        const rows = prices.rows.filter((r) => r.provider === provider)
        const priced = (r: (typeof rows)[number]) =>
          r.input_per_mtok !== null || r.output_per_mtok !== null
        return json({
          ...prices,
          rows,
          matrix: {
            ...prices.matrix,
            providers: [provider],
            cells: prices.matrix.cells.filter((c) => c.provider === provider),
          },
          counts: {
            total: rows.length,
            priced: rows.filter((r) => !r.removed && priced(r)).length,
            catalog_only: rows.filter((r) => !r.removed && !priced(r)).length,
            removed: rows.filter((r) => r.removed).length,
          },
        })
      }),
  )

  server.registerTool(
    'get_price_history',
    {
      title: 'One SKU’s price series',
      description:
        'Every observation of one SKU key, oldest first: points carry kind (baseline = the price as of the source’s first snapshot, ' +
        'added, modified with the changed fields in diff, removed, or current), the three USD-per-million-token figures, and the fetch ' +
        'each was read from. A series is one price per revision of the vendor page, not a daily sample — a flat line is a page that did ' +
        'not change. removed=true when the newest observation is a delisting. Keys come from get_prices (entity_key); an unknown key is ' +
        'an error, not an empty series. Points with kind archived (basis archived) come first: read from the Internet Archive’s capture ' +
        'of the lab’s own page before we watched it; at is the capture time, source_url the capture. archive_only=true when every point is archived. ' +
        PROVENANCE,
      inputSchema: z.object({ key: SkuKeySchema, as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ key, as_of }) =>
      asOfErrors(async () => {
        const history = await read(
          'price-history',
          as_of,
          (ctx) => queryPriceHistory(deps.db, ctx, key),
          key,
          'pricing',
        )
        if (history === null) {
          return failure(
            `No SKU with key ${key}${as_of ? ` as of ${as_of}` : ''}. Keys are listed by get_prices.`,
          )
        }
        return json(history)
      }),
  )
}
