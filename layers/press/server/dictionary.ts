// The press layer's tables in the data dictionary: what each export cannot say about itself.
// Part of DICTIONARY_ENTRIES (server/registries/dictionary.ts).

const { entityId: ID } = DICTIONARY_COMMON

export const PRESS_DICTIONARY: Readonly<Record<string, DictionaryEntry>> = {
  track_record_candidates: {
    grain: 'One row per article or newsroom post found for an alert.',
    cadence:
      'Press articles from GDELT’s files, read twice an hour while an alert’s window is open. Newsroom posts within 5 minutes of the window closing.',
    event: 'published_at',
    knowledge: 'found_at',
    cut: 'Rows with found_at at or before as_of.',
    start: 'From the first notable or critical alert.',
    joins: [],
    feeds: ['track_record'],
  },
  track_record_verdicts: {
    grain: 'One row per candidate the judge rated.',
    cadence: 'When the judge runs.',
    event: null,
    knowledge: 'judged_at',
    cut: 'Rows with judged_at at or before as_of.',
    start: 'From the first rated candidate.',
    joins: [],
    feeds: ['track_record'],
  },
  reported_articles: {
    grain: 'One row per article URL.',
    cadence: 'Hourly, as each GDELT file is read.',
    event: 'published_at',
    knowledge: 'found_at',
    cut: 'Rows with found_at at or before as_of.',
    start:
      'From GDELT’s files of 2026-09-01, read again for figures from 2026-11-07. Back to 2023-01-01 on the days whose hourly sample carried figure headlines, and the day either side, read from 2026-11-21 (found_at says when).',
    joins: [],
    feeds: ['track_record'],
  },
  reported_figures: {
    grain: 'One row per figure a headline states.',
    cadence: 'When the judge runs.',
    event: 'published_at',
    knowledge: 'judged_at',
    cut: 'Rows with judged_at at or before as_of.',
    start: 'From the first headline the judge read.',
    joins: [{ column: 'lab', to: ID }],
    feeds: ['track_record'],
  },
}
