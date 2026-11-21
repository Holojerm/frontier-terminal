// The pricing layer's tables in the data dictionary: what each export cannot say about itself.
// Part of DICTIONARY_ENTRIES (server/registries/dictionary.ts).

const { byProvider } = DICTIONARY_COMMON

export const PRICING_DICTIONARY: Readonly<Record<string, DictionaryEntry>> = {
  prices_latest: {
    grain: 'One row per SKU per source, as of the last check.',
    cadence:
      'Model catalogs every 5 minutes when they change, lab price lists every 30 minutes, every source every 6 hours.',
    event: 'effective_from',
    knowledge: 'first_seen_at',
    start:
      'Current rows only. Past prices are in changes (from our first check) and archived_prices (Internet Archive copies from January 2023).',
    joins: [byProvider],
    feeds: [{ axes: ['pricing-catalog', 'pricing-cross-check'] }],
  },
  archived_prices: {
    grain: 'One row per SKU per Internet Archive copy we could read.',
    cadence: 'Once per backfill run, not on a schedule.',
    event: 'captured_at',
    knowledge: 'fetched_at',
    cut: 'Rows with captured_at at or before as_of: when the Internet Archive saw the page, not when we read the copy (fetched_at, always later). So a backtest gets the page as it stood then, which this site did not hold at the time.',
    start:
      'Archived only. From the oldest copy we could read. The backfill looks at one copy a week from January 2023 to 2026-08-25.',
    joins: [byProvider],
    feeds: [{ ids: ['wayback-pricing'] }],
  },
  archived_rate_limits: {
    grain:
      'One row per limit per Internet Archive copy of a lab’s rate-limit page we could read: per-model rates where the copy names the tier, and the usage-tier table.',
    cadence: 'Once per backfill run, not on a schedule.',
    event: 'captured_at',
    knowledge: 'fetched_at',
    cut: 'Rows with captured_at at or before as_of: when the Internet Archive saw the rate-limit page, not when we read the copy (fetched_at, always later). So a backtest gets the page as it stood then, which this site did not hold at the time.',
    start:
      'Archived only. Anthropic from March 2024 (the oldest copy that reads) to 2026-11-04, the first run of the live limits recipes. OpenAI’s, xAI’s and Meta’s pages have no copies that read.',
    joins: [byProvider],
    feeds: [{ ids: ['wayback-limits'] }],
  },
}
