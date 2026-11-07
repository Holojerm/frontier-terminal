// Which sources are 'set' lanes (the page IS the current set), kept apart from
// lanes.ts so read-path code can ask without importing every parser. The
// removals test pins this table to LANES.

const SET_SOURCES: ReadonlySet<string> = new Set([
  'openai-models-md',
  'openai-pricing-md',
  'anthropic-models-md',
  'anthropic-pricing-md',
  'xai-models-md',
  'meta-models-md',
  'meta-pricing-md',
  'mistral-models-md',
  'mistral-pricing-md',
  'deepseek-pricing-md',
  'alibaba-pricing-html',
  'alibaba-models-html',
  'moonshot-models-md',
  'google-pricing-html',
  'google-models-md',
  'openai-ashby',
  'mistral-ashby',
  'google-careers',
  'anthropic-greenhouse',
  'xai-greenhouse',
  'openai-misalignment-reports',
])

const SET_DERIVED_PREFIXES: readonly string[] = [
  'filing-index-',
  'openai-model-md-',
  'google-model-md-',
  'openai-misalignment-report-',
]

/** True when the source's stored rows mirror its page, so a vanished entity is a removal. */
export function isSetLane(sourceId: string): boolean {
  return SET_SOURCES.has(sourceId) || SET_DERIVED_PREFIXES.some((p) => sourceId.startsWith(p))
}
