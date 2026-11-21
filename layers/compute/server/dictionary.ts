// The compute layer's tables in the data dictionary: what each export cannot say about itself.
// Part of DICTIONARY_ENTRIES (server/registries/dictionary.ts).

const { byProvider } = DICTIONARY_COMMON

export const COMPUTE_DICTIONARY: Readonly<Record<string, DictionaryEntry>> = {
  archived_gpu_prices: {
    grain:
      'One row per priced H100 or B200 configuration per Internet Archive copy of a GPU provider’s price page we could read.',
    cadence: 'Once per backfill run, not on a schedule.',
    event: 'captured_at',
    knowledge: 'fetched_at',
    cut: 'Rows with captured_at at or before as_of: when the Internet Archive saw the provider’s price page, not when we read the copy (fetched_at, always later). So a backtest gets the page as it stood then, which this site did not hold at the time.',
    start:
      'Archived only. From the oldest copy we could read (Lambda, June 2023). The backfill looks at one copy a week from January 2023 to 2026-11-01, the first day of the live GPU price checks.',
    joins: [byProvider],
    feeds: [{ ids: ['wayback-gpu'] }],
  },
  power_site_ties: {
    grain:
      'One row per company a page ties to a lab’s data-center site, and one per site whose grid a page names.',
    cadence:
      'Daily for SEC filings. We search EDGAR for new filings naming each site once a day, and a model reads the ties from them. A row ends when the filer’s next filing of its form drops the quote. Weekly for every other page. We re-read it, restamp fetched_at, and flag a quote that is gone.',
    event: 'published',
    knowledge: 'fetched_at',
    start: 'The hand read of 2026-11-19 and 2026-11-20, then every SEC filing naming a site since.',
    joins: [{ column: 'ticker', to: 'your security master' }],
    feeds: ['power_sites'],
  },
  grid_load_days: {
    grain: 'One row per balancing authority and local day.',
    cadence:
      'Six-hourly. We read EIA’s API from six weeks before the newest day we hold, or the current six-month file when the API fails. A day EIA revises is rewritten in place.',
    event: 'date',
    knowledge: 'fetched_at',
    start: '2018-01-01: 2018 from EIA’s six-month files, 2019 on from its API.',
    joins: [],
    feeds: [{ ids: ['eia930-api', 'eia930-balance'] }],
  },
  ercot_large_load_facts: {
    grain: 'One row per figure an ERCOT report states, per report.',
    cadence:
      'Six-hourly checks of ERCOT’s Board and presentations pages. A report is read once, when it is first linked.',
    event: 'posted',
    knowledge: 'fetched_at',
    cut: 'Rows with fetched_at at or before as_of: when we read the report.',
    start:
      'ERCOT’s Monthly Operational Overview from January 2025 and its ERCOT Monthly from November 2025.',
    joins: [],
    feeds: [{ ids: ['ercot-large-loads'] }],
  },
  hardware_prints: {
    grain:
      'One row per figure a source gave for a company’s month (or Korea’s chip exports for a month or its first 10 or 20 days), each vintage its own row.',
    cadence:
      'Hourly. Taiwan revenue is due by the 10th of the next month, and TSMC files its 6-K the same day. Korea Customs Service posts the 10-day figure on the 11th, the 20-day figure on the 21st and the confirmed month around the 15th.',
    event: 'period',
    knowledge: 'first_seen_at',
    cut: 'Rows with first_seen_at at or before as_of: each month as we held it then. A backfilled row was read after its release, so for it published_at, where set, is the release time.',
    start:
      'TSMC from January 2015 (its 6-Ks), Accton from July 2023 (its own page), the others from our first read of the exchange feed on 2026-11-21. Korea’s chip exports from September 2026, the first releases under KOGL Type 1.',
    joins: [
      { column: 'ticker', to: 'your security master' },
      { column: 'entity', to: 'your security master' },
    ],
    // The figures' sources. The ties aren't rows of this table, and the held KCS releases are never exported.
    feeds: [
      {
        ids: [
          'twse-monthly-revenue',
          'tsmc-revenue-6k',
          'accton-monthly-revenue',
          'kcs-chip-exports',
        ],
      },
    ],
  },
}
