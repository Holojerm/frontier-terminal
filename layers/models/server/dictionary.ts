// The models layer's tables in the data dictionary: what each export cannot say about itself.
// Part of DICTIONARY_ENTRIES (server/registries/dictionary.ts).

const { survey: SURVEY, byProvider } = DICTIONARY_COMMON

export const MODELS_DICTIONARY: Readonly<Record<string, DictionaryEntry>> = {
  disclosures: {
    grain: 'One row per entry on a lab’s misalignment-disclosure index.',
    cadence: SURVEY,
    event: 'listed_on',
    knowledge: 'first_seen_at',
    start: 'Every entry the index lists, back to its first.',
    joins: [byProvider],
    feeds: [{ axes: ['disclosures'] }],
  },
  disclosure_timelines: {
    grain: 'One row per disclosure report page.',
    cadence: SURVEY,
    event: 'disclosed_on',
    knowledge: 'first_seen_at',
    start: 'Every report the index links to.',
    joins: [byProvider],
    feeds: [{ axes: ['disclosures'] }],
  },
}
