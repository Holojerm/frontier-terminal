// The like-for-like map: which SKU is each provider's answer to the same
// question. This is the ONE editorial judgment in the UI, so it is written
// to be checkable rather than trusted:
//
//   - the rule is uniform — a class is defined by what the vendor's own
//     docs recommend, not by our read of benchmarks or capability;
//   - every entry quotes the vendor sentence it rests on, verbatim from a
//     committed fixture (markdown link syntax flattened to its text, nothing
//     else touched), with the source_id that sentence came from — a golden
//     test greps each quote back out of its fixture, so a rewritten vendor
//     page fails CI instead of quietly aging into fiction;
//   - a provider that publishes no such recommendation gets a stated gap,
//     never a guess (xAI names one model and stops; Google's pricing page
//     carries no recommendation text at all).
//
// Prices are never in this file. They come from the store, with the row's
// own provenance, and the class map only says which row to put where.

import type { BigFour, ClassColumn, ModelClassId } from '#shared/utils/terminal-types'

export const MODEL_CLASSES: ClassColumn[] = [
  {
    id: 'flagship',
    label: 'Flagship',
    question: 'the vendor’s own “start here” model for hard work',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    question: 'the vendor’s stated intelligence-for-cost tradeoff',
  },
  {
    id: 'economy',
    label: 'Economy',
    question: 'the vendor’s model for cost-sensitive, high-volume work',
  },
]

export interface ClassEntry {
  provider: BigFour
  class: ModelClassId
  /** entity model_slug, exactly as the parser stored it. */
  model_slug: string
  /** Vendor's own words. Verbatim from the fixture named below. */
  basis: string
  /** source_id the sentence was transcribed from (fixtures/manifest.json). */
  basis_source_id: string
}

// Verbatim transcriptions, checked against the committed fixtures on
// 2026-08-25 and re-verified against this repo's copies on 2026-09-07. If a
// vendor rewrites its recommendation, this map is stale and must be
// re-transcribed — the UI labels it as an editorial mapping for exactly that
// reason.
export const MODEL_CLASS_MAP: ClassEntry[] = [
  {
    provider: 'openai',
    class: 'flagship',
    model_slug: 'gpt-5.6-sol',
    basis: 'Start here for complex reasoning and coding.',
    basis_source_id: 'openai-models-md',
  },
  {
    provider: 'openai',
    class: 'balanced',
    model_slug: 'gpt-5.6-terra',
    basis: 'Balance intelligence and cost.',
    basis_source_id: 'openai-models-md',
  },
  {
    provider: 'openai',
    class: 'economy',
    model_slug: 'gpt-5.6-luna',
    basis: 'Optimize cost-sensitive, high-volume workloads.',
    basis_source_id: 'openai-models-md',
  },
  {
    provider: 'anthropic',
    class: 'flagship',
    model_slug: 'claude-opus-5',
    basis:
      "If you're unsure which model to use, start with Claude Opus 5 for complex agentic coding and enterprise work; for the highest available capability, use Claude Fable 5.",
    basis_source_id: 'anthropic-models-md',
  },
  {
    provider: 'anthropic',
    class: 'balanced',
    model_slug: 'claude-sonnet-5',
    basis: 'The best combination of speed and intelligence',
    basis_source_id: 'anthropic-models-md',
  },
  {
    provider: 'anthropic',
    class: 'economy',
    model_slug: 'claude-haiku-4-5',
    basis: 'The fastest model with near-frontier intelligence',
    basis_source_id: 'anthropic-models-md',
  },
  {
    provider: 'xai',
    class: 'flagship',
    model_slug: 'grok-4.6',
    basis:
      'For everything else, including code, use Grok 4.6. It is the most intelligent and fastest model we’ve built.',
    basis_source_id: 'xai-models-md',
  },
]

/** Why a (provider, class) cell has no mapping. Displayed instead of a number. */
export const CLASS_GAPS: { provider: BigFour; class: ModelClassId; reason: string }[] = [
  {
    provider: 'xai',
    class: 'balanced',
    reason:
      'xAI’s models page recommends one model and stops — no balanced tier is published, and the cheaper grok SKUs carry no positioning to transcribe.',
  },
  {
    provider: 'xai',
    class: 'economy',
    reason:
      'Same gap: xAI publishes prices for grok-4.3 and grok-build-0.1 (see the full catalog) but no statement that either is the cost-sensitive choice.',
  },
  {
    provider: 'google',
    class: 'flagship',
    reason:
      'Google’s pricing page prints prices but no recommendation text; no Gemini model is mapped until a vendor sentence exists to transcribe. Every Gemini SKU is in the full catalog.',
  },
  {
    provider: 'google',
    class: 'balanced',
    reason: 'Same gap — no published recommendation to map against.',
  },
  {
    provider: 'google',
    class: 'economy',
    reason: 'Same gap — no published recommendation to map against.',
  },
]

/**
 * Why a mapped cell has no price. Distinct from a missing mapping: the SKU
 * is the right one, the audited source simply does not print its price.
 */
export const PRICE_GAPS: Readonly<Partial<Record<BigFour, string>>> = {
  openai:
    'OpenAI’s audited source (developers.openai.com/api/docs/models.md) is a catalog: it lists every SKU with a one-line description and prints no prices. Per-model pages carry them; they are not fetched, so nothing is shown here rather than a number from elsewhere.',
}

/** The generic reason when a mapped SKU has simply not been stored yet. */
export const NO_ROW_GAP = 'No row for this SKU in the store yet — the source has not been polled.'
