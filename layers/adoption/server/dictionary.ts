// The adoption layer's tables in the data dictionary: what each export cannot say about itself.
// Part of DICTIONARY_ENTRIES (server/registries/dictionary.ts).

const { entityId: ID } = DICTIONARY_COMMON

export const ADOPTION_DICTIONARY: Readonly<Record<string, DictionaryEntry>> = {
  download_series: {
    grain: 'One row per series and day.',
    cadence: 'Rebuilt from recipe_observations on each request.',
    event: 'date',
    knowledge: 'fetched_at',
    start:
      'npm normalized series from each package’s first release (2022-01-01 at the earliest), npm shares from 2025-03-11, PyPI shares from the first PyPI day stored.',
    joins: [{ column: 'company', to: ID }],
    feeds: ['recipes'],
  },
}
