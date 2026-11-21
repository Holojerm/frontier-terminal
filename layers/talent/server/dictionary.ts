// The talent layer's tables in the data dictionary: what each export cannot say about itself.
// Part of DICTIONARY_ENTRIES (server/registries/dictionary.ts).

const { survey: SURVEY, byProvider } = DICTIONARY_COMMON

export const TALENT_DICTIONARY: Readonly<Record<string, DictionaryEntry>> = {
  jobs_open: {
    grain: 'One row per open role per job board.',
    cadence: SURVEY,
    event: 'published_at',
    knowledge: 'first_seen_at',
    start:
      'Current roles only. Roles that closed are in changes, from our first check. Open-role counts before then are in archived_hiring (Internet Archive copies from January 2023).',
    joins: [byProvider],
    feeds: [{ axes: ['hiring'] }],
  },
  archived_hiring: {
    grain:
      'One board row per Internet Archive copy of a lab’s job board we could read, and one row per department when the copy lists every role.',
    cadence: 'Once per backfill run, not on a schedule.',
    event: 'captured_at',
    knowledge: 'fetched_at',
    cut: 'Rows with captured_at at or before as_of: when the Internet Archive saw the board, not when we read the copy (fetched_at, always later). So a backtest gets the board as it stood then, which this site did not hold at the time.',
    start:
      'Archived only. From the oldest copy we could read (OpenAI 2023-01-08). The backfill looks at one copy a week from January 2023 to the day we began reading each board.',
    joins: [byProvider],
    feeds: [{ ids: ['wayback-hiring'] }],
  },
  listed_jobs: {
    grain: 'One row per role a listed company’s job board has listed, open or closed.',
    cadence: 'Daily at 04:00 UTC, one request per board.',
    event: 'published_at',
    knowledge: 'first_seen_at',
    start: 'Our first read of each board, 2026-11-21. Roles that closed before then are not here.',
    joins: [],
    feeds: ['listed_hiring'],
  },
  listed_hiring_reads: {
    grain: 'One row per read of a listed company’s job board.',
    cadence: 'Daily at 04:00 UTC.',
    event: 'read_at',
    knowledge: 'read_at',
    cut: 'Rows with read_at at or before as_of: when we read the board.',
    start: 'Our first read of each board, 2026-11-21.',
    joins: [],
    feeds: ['listed_hiring'],
  },
}
