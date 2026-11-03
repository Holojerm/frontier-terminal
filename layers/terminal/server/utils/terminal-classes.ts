// The like-for-like map: which SKU is each provider's answer to the same
// question. This is the ONE editorial judgment in the UI, so it is written
// to be checkable rather than trusted:
//
//   - the rule is uniform — a class is defined by what the vendor's own
//     docs recommend, not by our read of benchmarks or capability;
//   - every entry quotes the vendor sentence it rests on, verbatim from a
//     committed fixture (markdown link syntax flattened to its text, nothing
//     else touched), with the source_id that sentence came from — a golden
//     test greps each quote back out of its fixture, so a mis-transcription
//     fails CI;
//   - the fixture is a moment in time, so every poll re-checks each sentence
//     against the live page (layers/terminal/server/pipeline/recommendations.ts): a vendor
//     that rewrites its recommendation flips the cell's `basis_current` to
//     false, lands a 'modified' change in the feed and an ops event in the
//     digest, and the matrix says the mapping is under review — instead of
//     the old mapping quietly aging into fiction;
//   - a cell under review is handed to the judge routine with the page it
//     rests on, and the judge may re-map it. The Worker accepts that only
//     under the same rule — the new sentence verbatim on the stored page, the
//     slug one the store lists — and records it in class_map_decisions
//     (layers/terminal/server/pipeline/judge/class-map.ts). This file is the seed; the
//     newest decision per cell overrides it (layers/terminal/server/pipeline/class-map.ts);
//   - a provider that publishes no such recommendation gets a stated gap,
//     never a guess (xAI names one model and stops; Google names no
//     intelligence-for-cost model on a current generation).
//
// Prices are never in this file. They come from the store, with the row's
// own provenance, and the class map only says which row to put where.

import type { LabId, ClassColumn, ModelClassId } from '../../shared/utils/terminal-types'

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
  provider: LabId
  class: ModelClassId
  /** entity model_slug, exactly as the parser stored it. */
  model_slug: string
  /** Vendor's own words. Verbatim from the fixture named below. */
  basis: string
  /** source_id the sentence was transcribed from (fixtures/manifest.json). */
  basis_source_id: string
  /**
   * Set on an entry a judge decision produced: when the Worker found the
   * sentence on the stored page. Stands in for the drift check until the next
   * poll that parses that page re-checks it.
   */
  verified_at?: string
}

/**
 * The page each provider's class map may rest on — the sources the seed
 * below was transcribed from, and the only ones a judge decision may cite.
 */
export const CLASS_MAP_SOURCES: Readonly<Partial<Record<LabId, string>>> = {
  openai: 'openai-models-md',
  anthropic: 'anthropic-models-md',
  xai: 'xai-models-md',
  meta: 'meta-models-md',
  google: 'google-models-md',
}

// Verbatim transcriptions from the fixtures fetched 2026-09-22 (the previous
// set, transcribed 2026-08-25, was found stale on 2026-09-22: all three
// vendors had rewritten their recommendation — GPT-6 Astra, Grok 4.7, and a
// new Opus 5 / Fable 5.1 sentence — while the matrix kept showing the old
// slugs). The rule stays "the vendor's start-here model": Anthropic's page
// names Opus as the start-here and Fable 5.1 as the escalation for work
// that still falls short on it, so Opus is the flagship cell and Fable 5.1
// is in the full catalog. Anthropic re-transcribed 2026-10-12: the 5.5
// generation replaced Opus 5, Sonnet 5 and Haiku 4.5 in the comparison
// table, and Haiku's old "fastest model" description is gone. When a check
// flips `basis_current` off, re-transcribe here and refresh the fixture.
export const MODEL_CLASS_MAP: ClassEntry[] = [
  {
    provider: 'openai',
    class: 'flagship',
    model_slug: 'gpt-6-astra',
    basis:
      "If you're not sure where to start, use GPT-6 Astra, our flagship model for complex reasoning and coding.",
    basis_source_id: 'openai-models-md',
  },
  {
    provider: 'openai',
    class: 'balanced',
    model_slug: 'gpt-5.6-terra',
    basis: 'Choose GPT-5.6 Terra to balance intelligence and cost',
    basis_source_id: 'openai-models-md',
  },
  {
    provider: 'openai',
    class: 'economy',
    model_slug: 'gpt-5.6-luna',
    basis: 'GPT-5.6 Luna for cost-sensitive, high-volume workloads.',
    basis_source_id: 'openai-models-md',
  },
  {
    provider: 'anthropic',
    class: 'flagship',
    model_slug: 'claude-opus-5-5',
    basis: "If you're unsure which model to use, start with Claude Opus 5.5 for most workloads.",
    basis_source_id: 'anthropic-models-md',
  },
  {
    provider: 'anthropic',
    class: 'balanced',
    model_slug: 'claude-sonnet-5-5',
    basis: 'The best combination of speed and intelligence',
    basis_source_id: 'anthropic-models-md',
  },
  {
    provider: 'anthropic',
    class: 'economy',
    model_slug: 'claude-haiku-5-5',
    basis:
      'For high-volume, latency-sensitive tasks such as classification, extraction, and routing',
    basis_source_id: 'anthropic-models-md',
  },
  {
    provider: 'xai',
    class: 'flagship',
    model_slug: 'grok-4.7',
    basis:
      'For everything else, including code, use Grok 4.7. It is the most capable model we’ve built.',
    basis_source_id: 'xai-models-md',
  },
  // Transcribed 2026-10-12. Meta splits its two API text lines by workload,
  // not by tier: Muse Wonder for capability, Muse Spark for cost-sensitive
  // volume. The economy sentence names the line; muse-spark-1.3 is the
  // version the same page marks "Recommended for new work."
  {
    provider: 'meta',
    class: 'flagship',
    model_slug: 'muse-wonder-1.0',
    basis:
      "Muse Wonder is Meta's most capable model, built for complex software engineering and long-horizon agentic work.",
    basis_source_id: 'meta-models-md',
  },
  {
    provider: 'meta',
    class: 'economy',
    model_slug: 'muse-spark-1.3',
    basis:
      'high-volume, latency-sensitive, or cost-sensitive work, such as sub-agent tasks, classification, and tight tool loops.',
    basis_source_id: 'meta-models-md',
  },
  // Transcribed 2026-11-01, when Google's models page first served markdown;
  // the flagship sentence re-transcribed 2026-11-03, when the page moved to
  // AI Studio and its card read "shared" where it had read "unified".
  // Each sentence is the description on that model's own card.
  {
    provider: 'google',
    class: 'flagship',
    model_slug: 'gemini-4-argon',
    basis:
      'Our flagship reasoning model with a shared 1M context window and long decodes up to 1M tokens.',
    basis_source_id: 'google-models-md',
  },
  {
    provider: 'google',
    class: 'economy',
    model_slug: 'gemini-3.5-flash-lite',
    basis: 'Our fastest, most cost-effective 3.5 model for high-throughput execution.',
    basis_source_id: 'google-models-md',
  },
]

/** Why a (provider, class) cell has no mapping. Displayed instead of a number. */
export const CLASS_GAPS: { provider: LabId; class: ModelClassId; reason: string }[] = [
  {
    provider: 'xai',
    class: 'balanced',
    reason:
      'xAI’s models page recommends one model and names no balanced tier. The cheaper grok SKUs have no positioning statement to transcribe.',
  },
  {
    provider: 'xai',
    class: 'economy',
    reason:
      'xAI publishes prices for grok-4.3 and grok-build-0.1 (full catalog) but no statement that either is the cost-sensitive choice.',
  },
  {
    provider: 'google',
    class: 'balanced',
    reason:
      'Google’s only price-performance sentence (“Our best price-performance model”) describes Gemini 2.5 Flash, a previous generation; the same page directs new projects to its latest models. No current model has such a sentence. Every Gemini SKU is in the full catalog.',
  },
  {
    provider: 'meta',
    class: 'balanced',
    reason:
      'Meta’s models page lists two API text lines, Muse Wonder for capability and Muse Spark for cost-sensitive volume, and names no middle tier.',
  },
  // Checked 2026-11-01 across models.md, the model selection guide and each
  // model's own page. Mistral Large 4 is the printed replacement for the one
  // model called "frontier-class" (Medium 3.5, deprecated 2026-10-31), but a
  // replacement column is not a sentence, so no cell is mapped from it.
  {
    provider: 'mistral',
    class: 'flagship',
    reason:
      'Mistral’s docs name no flagship or start-here model: Mistral Large 4 is “a state-of-the-art, open-weight, general-purpose multimodal model,” and the one “frontier-class” sentence belongs to the deprecated Medium 3.5. Every Mistral SKU is in the full catalog.',
  },
  {
    provider: 'mistral',
    class: 'balanced',
    reason: 'No Mistral page names a middle tier.',
  },
  {
    provider: 'mistral',
    class: 'economy',
    reason:
      'Mistral prints speed and performance ratings, not a cost-sensitive recommendation. Its cheapest generalists have no positioning statement to transcribe.',
  },
]

/**
 * Why a mapped cell has no price. Distinct from a missing mapping: the SKU
 * is the right one, the audited source simply does not print its price.
 */
export const PRICE_GAPS: Readonly<Partial<Record<LabId, string>>> = {
  openai:
    'OpenAI’s catalog page (developers.openai.com/api/docs/models.md) prints no prices. Prices come from pricing.md, polled separately (registered 2026-09-22). No priced row means that source has not been polled yet; no price from another source is shown.',
}

/** The generic reason when a mapped SKU has simply not been stored yet. */
export const NO_ROW_GAP = 'No stored row for this SKU. The source has not been polled.'

/**
 * Shown on a cell whose vendor sentence was not found on the page at the
 * last poll. The price is still the stored price for the mapped SKU; what
 * is in doubt is whether that SKU still answers the column's question.
 */
export const BASIS_STALE_NOTE =
  'At the last poll, the vendor page no longer contained the sentence this mapping quotes. The class assignment is under review. The price shown is the stored price for this SKU; the vendor may now recommend a different one (full catalog).'
