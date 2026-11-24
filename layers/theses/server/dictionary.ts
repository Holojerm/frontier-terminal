// The theses layer's tables in the data dictionary: what each export cannot say about itself.
// Part of DICTIONARY_ENTRIES (server/registries/dictionary.ts).

const { survey: SURVEY, live: LIVE, byProvider } = DICTIONARY_COMMON

export const THESES_DICTIONARY: Readonly<Record<string, DictionaryEntry>> = {
  claim_readings: {
    grain: 'One row per thesis claim and data date.',
    cadence: SURVEY,
    event: 'date',
    knowledge: 'computed_at',
    start: 'From the first data date each claim’s recipe reads.',
    joins: [],
    feeds: ['all', 'recipes'],
  },
  claim_status_changes: {
    grain: 'One row per change of a thesis claim’s computed status.',
    cadence: 'When a survey or a judge run computes a status that differs from the claim’s last.',
    event: 'changed_at',
    knowledge: 'changed_at',
    cut: 'Rows with changed_at at or before as_of: a status change is never rewritten, so the trail is exact at any past moment.',
    start: LIVE,
    joins: [],
    feeds: ['all', 'recipes'],
  },
  claim_verdicts: {
    grain: 'One row per candidate event the judge rated for a claim.',
    cadence: 'When the judge runs.',
    event: 'detected_at',
    knowledge: 'judged_at',
    cut: 'Verdicts with detected_at and judged_at both at or before as_of: a verdict is held back until it was judged.',
    start: LIVE,
    joins: [byProvider],
    feeds: ['all', 'recipes'],
  },
}
