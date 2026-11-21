// The reliability layer's tables in the data dictionary: what each export cannot say about itself.
// Part of DICTIONARY_ENTRIES (server/registries/dictionary.ts).

const { survey: SURVEY, byProvider, entityId: ID } = DICTIONARY_COMMON

export const RELIABILITY_DICTIONARY: Readonly<Record<string, DictionaryEntry>> = {
  incidents: {
    grain: 'One row per status-page incident.',
    cadence: SURVEY,
    event: 'started_at',
    knowledge: 'first_seen_at',
    start: 'What each feed listed at our first check, and every incident since.',
    joins: [byProvider],
    feeds: [{ axes: ['status'] }],
  },
  latency_probes: {
    grain: 'One row per probe: one streaming request to one lab’s flagship model.',
    cadence: 'Hourly, one probe per lab.',
    event: 'started_at',
    knowledge: 'fetched_at',
    cut: 'Rows with started_at at or before as_of.',
    start: 'From our first probe of each lab, in November 2026.',
    joins: [{ column: 'lab', to: ID }],
    feeds: ['own'],
  },
  probe_days: {
    grain: 'One row per lab and UTC day.',
    cadence: 'Rolled again from latency_probes after every hourly run, for the days it touched.',
    event: 'day',
    knowledge: 'fetched_at',
    start: 'From our first probe of each lab, in November 2026.',
    joins: [{ column: 'lab', to: ID }],
    feeds: ['own'],
  },
  archived_incidents: {
    grain:
      'One row per incident any Internet Archive copy of a lab’s status feed listed, in the newest such copy’s state.',
    cadence: 'Once per backfill run, not on a schedule.',
    event: 'started_at',
    knowledge: 'fetched_at',
    cut: 'Rows with captured_at at or before as_of: when the Internet Archive took the newest copy listing the incident, not when we read it (fetched_at, always later). A row holds the newest copy’s state only, so a backtest at an earlier as_of misses incidents whose newest copy is later, and gets no older state of the rest.',
    start:
      'Archived only. From the oldest copy of each feed (OpenAI and Anthropic from January 2023, DeepSeek from June 2024, xAI from January 2025, Google Cloud’s copies each reaching a year back) to the day each live status lane began. Mistral has no copies.',
    joins: [byProvider],
    feeds: [{ ids: ['wayback-status'] }],
  },
}
