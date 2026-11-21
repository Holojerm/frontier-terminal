// Core's tables in the data dictionary: what each export cannot say about itself.
// Part of DICTIONARY_ENTRIES (server/registries/dictionary.ts).

const { live: LIVE, byProvider, survey: SURVEY, entityId: ID } = DICTIONARY_COMMON

export const CORE_DICTIONARY: Readonly<Record<string, DictionaryEntry>> = {
  snapshots: {
    grain: 'One row per fetch of a source.',
    cadence:
      'Model catalogs up to every 5 minutes, SEC feeds and lab price lists every 30, everything else every 6 hours.',
    event: null,
    knowledge: 'fetched_at',
    cut: 'Rows with fetched_at at or before as_of.',
    start: LIVE,
    joins: [],
    feeds: ['own'],
  },
  changes: {
    grain: 'One row per tracked item added, removed, or modified.',
    cadence: 'A check that finds a difference adds rows. Rows are never edited.',
    event: null,
    knowledge: 'detected_at',
    cut: 'Rows with detected_at at or before as_of.',
    start: LIVE,
    joins: [byProvider],
    feeds: ['all'],
  },
  alerts: {
    grain: 'One row per alert.',
    cadence:
      'Written when a check finds a change that meets a rule. Judged alerts follow when the judge runs.',
    event: null,
    knowledge: 'created_at',
    cut: ALERTS_METHOD,
    start: LIVE,
    joins: [],
    feeds: ['all'],
  },
  recipe_observations: {
    grain: 'One row per recipe, key, and date.',
    cadence: SURVEY,
    event: 'date',
    knowledge: 'first_seen_at',
    start:
      'Depends on the recipe. Some read a full history at their first run, others start at it.',
    joins: [{ column: 'company', to: ID }],
    feeds: ['recipes'],
  },
  archive_captures: {
    grain: 'One row per Internet Archive copy the backfill considered.',
    cadence: 'Once per backfill run, not on a schedule.',
    event: 'captured_at',
    knowledge: 'fetched_at',
    cut: 'Rows with captured_at at or before as_of: when the Internet Archive saw the page, not when we read the copy.',
    start:
      'Archived only. One copy a week per lab pricing page, job board or GPU provider price page, and every copy of each lab’s status feed (one a month for Google Cloud), from January 2023 to the day we began reading it.',
    joins: [byProvider],
    feeds: ['archive'],
  },
  source_runs: {
    grain: 'One row per check of a source.',
    cadence:
      'Model catalogs up to every 5 minutes, SEC feeds and lab price lists every 30, everything else every 6 hours.',
    event: null,
    knowledge: 'started_at',
    cut: 'Rows with started_at at or before as_of.',
    start: LIVE,
    joins: [],
    feeds: ['own'],
  },
}
