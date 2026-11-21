// The signals layer's tables in the data dictionary: what each export cannot say about itself.
// Part of DICTIONARY_ENTRIES (server/registries/dictionary.ts).

export const SIGNALS_DICTIONARY: Readonly<Record<string, DictionaryEntry>> = {
  signal_results: {
    grain: 'One row per series, ticker, horizon and sample.',
    cadence: 'Recomputed whole once a day, after the US close.',
    event: 'to_date',
    knowledge: 'fetched_at',
    start: 'Each series from its own first observation; prices from 2018-05-01 or the listing.',
    joins: [{ column: 'ticker', to: 'entity_identifiers.ticker' }],
    feeds: ['own'],
  },
  forward_calls: {
    grain: 'One row per forward call.',
    cadence: 'Registered calls with each deploy; rule calls on the daily run after the US close.',
    event: 'period_end',
    knowledge: 'recorded_at',
    cut: 'Rows with recorded_at at or before as_of: the calls made by then. A registered call is dated the day it was committed.',
    start: '2026-11-20, the first call.',
    joins: [{ column: 'ticker', to: 'entity_identifiers.ticker' }],
    feeds: ['own', 'filed_facts', 'calls', 'prints'],
    licenseNote:
      'methods are ours. inputs quote filed figures, call guidance and hardware prints under their own sources’ terms; a print held under its source’s terms has no value.',
  },
  forward_call_scores: {
    grain: 'One row per forward call and method, once the period is filed.',
    cadence: 'Daily, after the US close, from the XBRL the call reader holds.',
    event: 'filed',
    knowledge: 'first_seen_at',
    cut: 'Rows with first_seen_at at or before as_of: each call as settled then.',
    start: 'The first filing after 2026-11-20 that settles a call.',
    joins: [],
    feeds: ['own', 'filed_facts'],
  },
}
