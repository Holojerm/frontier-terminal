import type { ScopeEntry } from '#layers/core/server/pipeline/scopes'

// A model launch lands on these pages first: the vendor's own price list and
// catalog. On the six-hourly survey alone a launch could sit unreported for
// most of a working day; on the edgar tick it waits at most 30 minutes. Each is
// one small document hashed against the last, so an unchanged re-fetch diffs
// to zero. OpenRouter's model list stays on the survey: it has no lane (a
// cross-check, never a source of record), so polling it faster would only
// store bytes. The derived per-model OpenAI pages stay there too: they add
// context windows to a SKU these pages already announced.
export const LAUNCH_SOURCES: readonly string[] = [
  'openai-models-md',
  'openai-pricing-md',
  'anthropic-models-md',
  'anthropic-pricing-md',
  'xai-models-md',
  'google-pricing-html',
  'google-models-md',
  'meta-models-md',
  'meta-pricing-md',
  'mistral-models-md',
  'mistral-pricing-md',
  'deepseek-pricing-md',
  'alibaba-pricing-html',
  'alibaba-models-html',
  'moonshot-models-md',
]

/** The catalogs' share of the edgar tick (server/registries/scopes.ts). */
export const LAUNCH_SCOPE: ScopeEntry = { sources: LAUNCH_SOURCES }
