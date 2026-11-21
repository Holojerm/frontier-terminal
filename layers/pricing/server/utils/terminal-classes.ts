// The like-for-like map: which SKU is each provider's answer to the same question. It is the
// ONE editorial judgment in the UI, so it is written to be checkable rather than trusted:
//
//   - the rule is uniform: a class is what the vendor's own docs recommend, not our read of
//     benchmarks or capability;
//   - every entry quotes the vendor sentence it rests on, verbatim from a committed fixture
//     (markdown links flattened to their text, nothing else touched), with the source_id it
//     came from; a golden test greps each quote back out of its fixture, so a
//     mis-transcription fails CI;
//   - every poll re-checks each sentence against the live page
//     (layers/pricing/server/pipeline/recommendations.ts): a rewritten recommendation flips
//     the cell's `basis_current` to false, lands a 'modified' change in the feed and an ops
//     event in the digest, and the matrix says the mapping is under review;
//   - a cell under review is handed to the judge routine with the page it rests on. The
//     Worker accepts a re-mapping only under the same rule (the new sentence verbatim on the
//     stored page, the slug one the store lists) and records it in class_map_decisions
//     (layers/pricing/server/pipeline/judge/class-map.ts). This file is the seed; the newest
//     decision per cell overrides it (layers/pricing/server/pipeline/class-map.ts);
//   - a provider that publishes no such recommendation gets a stated gap, never a guess (xAI
//     names one model and stops; DeepSeek's one catalog page is a price list). A launch
//     re-opens that provider's gaps to the judge for the review window, for the launched
//     models only.
//
// Prices are never in this file. They come from the store, with the row's own provenance, and
// the class map only says which row to put where.

import type { LabId } from '#layers/core/shared/types/common'
import type { ClassColumn, ModelClassId } from '../../shared/types/prices'

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
 * The pages each provider's class map may rest on — the sources the seed
 * below was transcribed from, and the only ones a judge decision may cite.
 * Each is drift-checked on every poll that reads it: a page with a parse lane
 * by that lane, a join page by the lane that joins it (Meta's Muse Spark page
 * is read with its models page, lanes.ts).
 */
export const CLASS_MAP_SOURCES: Readonly<Partial<Record<LabId, readonly string[]>>> = {
  openai: ['openai-models-md'],
  anthropic: ['anthropic-models-md'],
  xai: ['xai-models-md'],
  meta: ['meta-models-md', 'meta-muse-spark-md'],
  google: ['google-models-md'],
  alibaba: ['alibaba-models-html'],
  moonshot: ['moonshot-models-md'],
}

// Verbatim transcriptions from the committed fixtures. The rule is "the vendor's start-here
// model": Anthropic's page names Opus as the start-here and Fable as the escalation for work
// that still falls short on it, so Opus is the flagship cell and Fable is in the full
// catalog. When a check flips `basis_current` off, re-transcribe here and refresh the fixture.
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
    basis: 'If you’re unsure which model to use, start with Claude Opus 5.5 for most workloads.',
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
  // Meta splits its two API text lines by workload, not by tier: Muse Wonder for capability,
  // Muse Spark for work at scale. Economy is Muse Ember, whose one version is muse-ember-1.0.
  // Balanced rests on Muse Spark's own page, since models.md gives Muse Spark no cost reason:
  // "strong reasoning at a lower cost than Muse Wonder" is the intelligence-for-cost answer.
  // Meta's choose-a-model page says the same ("Use it when" under Muse Spark), but it is not
  // a registered source.
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
    class: 'balanced',
    model_slug: 'muse-spark-1.3',
    basis:
      'Use Muse Spark for agentic and coding work that needs strong reasoning at a lower cost than Muse Wonder',
    basis_source_id: 'meta-muse-spark-md',
  },
  {
    provider: 'meta',
    class: 'economy',
    model_slug: 'muse-ember-1.0',
    basis:
      'Muse Ember is the efficient execution model in the Muse family, built for high-volume, repeated work: sub-agent tasks, tool calls, routing, and processing large collections of images, files, and records.',
    basis_source_id: 'meta-models-md',
  },
  // Each sentence is the description on that model's own card. The balanced cell is
  // Hydrogen's card: "intelligence … with speed and efficiency" is the intelligence-for-cost
  // answer, and the same page tells new projects to use "Gemini 4 Hydrogen or 3.5 Flash-Lite"
  // and calls 3.8 Flash "Our previous-generation Flash model".
  {
    provider: 'google',
    class: 'flagship',
    model_slug: 'gemini-4-carbon',
    basis:
      'Our strongest reasoning model, built for complex software engineering, multimodal knowledge work, scientific reasoning, and cybersecurity defense.',
    basis_source_id: 'google-models-md',
  },
  {
    provider: 'google',
    class: 'balanced',
    model_slug: 'gemini-4-hydrogen',
    basis:
      'Brings cutting-edge intelligence to everyone, with speed and efficiency for everyday coding and agentic workflows, featuring a shared 1M context window and long decodes up to 1M tokens.',
    basis_source_id: 'google-models-md',
  },
  {
    provider: 'google',
    class: 'economy',
    model_slug: 'gemini-3.5-flash-lite',
    basis: 'Our fastest, most cost-effective 3.5 model for high-throughput execution.',
    basis_source_id: 'google-models-md',
  },
  // From Alibaba Cloud's "Recommended models" page, whose text-generation row names three Qwen
  // models, each with the use it is recommended for. The flagship cell reads "complex
  // reasoning and coding" as the page's answer for hard work, as OpenAI's flagship sentence
  // does.
  {
    provider: 'alibaba',
    class: 'flagship',
    model_slug: 'qwen4-max',
    basis: 'Complex reasoning and coding',
    basis_source_id: 'alibaba-models-html',
  },
  {
    provider: 'alibaba',
    class: 'balanced',
    model_slug: 'qwen3.7-plus',
    basis: 'Balanced performance, speed, and cost',
    basis_source_id: 'alibaba-models-html',
  },
  {
    provider: 'alibaba',
    class: 'economy',
    model_slug: 'qwen3.8-flash',
    basis: 'Fast and cost-effective',
    basis_source_id: 'alibaba-models-html',
  },
  // The served page prints no price (PRICE_GAPS).
  {
    provider: 'moonshot',
    class: 'flagship',
    model_slug: 'kimi-k3.1-pro',
    basis: "Kimi's most capable flagship to date",
    basis_source_id: 'moonshot-models-md',
  },
]

/** Why a (provider, class) cell has no mapping. Displayed instead of a number. */
export const CLASS_GAPS: { provider: LabId; class: ModelClassId; reason: string }[] = [
  {
    provider: 'xai',
    class: 'balanced',
    reason:
      'xAI’s models page answers “Which model should I choose?” with one model, Grok 4.7. It names no balanced tier. The cheaper SKUs’ own pages describe what each can do (“Fast, reliable model with strong tool calling”) and say nothing about cost.',
  },
  {
    provider: 'xai',
    class: 'economy',
    reason:
      'xAI prices grok-4.3, the grok-4.20 models, and grok-build-0.1 below Grok 4.7 (full catalog). No xAI page says which one to use for cost-sensitive work.',
  },
  // Checked across models.md, the model selection guide and each model's own page. Mistral
  // Large 4 is the printed replacement for the one model called "frontier-class" (Medium 3.5,
  // deprecated 2026-10-31), but a replacement column is not a sentence, so no cell is mapped
  // from it.
  {
    provider: 'mistral',
    class: 'flagship',
    reason:
      'Mistral’s docs name no flagship or start-here text model. Mistral Large 4 is “a state-of-the-art, open-weight, general-purpose multimodal model.” The one “frontier-class” sentence is about the deprecated Medium 3.5. The one model labeled “Flagship” is a transcription model (Voxtral Small Transcribe 3). Every Mistral SKU is in the full catalog.',
  },
  {
    provider: 'mistral',
    class: 'balanced',
    reason:
      'No Mistral page names a middle tier. The model selection guide rates speed and performance from 0 to 5 and says nothing about cost.',
  },
  {
    provider: 'mistral',
    class: 'economy',
    reason:
      'Mistral rates its models on speed and performance but never says which to use for cost-sensitive work. Its cheapest general-purpose models don’t say what they’re for.',
  },
  // DeepSeek's one catalog page is its price list.
  {
    provider: 'deepseek',
    class: 'flagship',
    reason:
      'DeepSeek’s models and pricing page lists two API models, deepseek-flash and deepseek-v4-pro, side by side with their versions, context and prices. No sentence says which one to start with. Both are in the full catalog.',
  },
  {
    provider: 'deepseek',
    class: 'balanced',
    reason:
      'DeepSeek sells two models and names no middle tier. The page compares them only on features, concurrency and price.',
  },
  {
    provider: 'deepseek',
    class: 'economy',
    reason:
      'deepseek-flash is the cheaper of DeepSeek’s two models, but no DeepSeek page says to use it for cost-sensitive work. Its off-peak prices, half the peak rate, are in the full catalog.',
  },
  {
    provider: 'moonshot',
    class: 'balanced',
    reason:
      'Moonshot’s model list names Kimi K3.1 Pro its flagship, a high-speed variant with “same intelligence, about 2-3× the speed”, and the previous-generation K3. None is described by cost.',
  },
  {
    provider: 'moonshot',
    class: 'economy',
    reason:
      'No Moonshot page names a model for cost-sensitive work. The K2 models that cost less are closed to new users.',
  },
]

/**
 * Why a mapped cell has no price. Distinct from a missing mapping: the SKU
 * is the right one, the audited source simply does not print its price.
 */
export const PRICE_GAPS: Readonly<Partial<Record<LabId, string>>> = {
  moonshot:
    'Moonshot’s pricing page (platform.kimi.ai/docs/pricing/chat) draws its price tables in the browser: the page as served, in Markdown and in HTML, holds an empty table. We read no price for any Kimi model rather than run the page’s scripts or read an aggregator’s.',
  openai:
    'OpenAI’s catalog page (developers.openai.com/api/docs/models.md) prints no prices. We read prices from a separate page, pricing.md (added 2026-09-22). No price here means pricing.md didn’t list this model at our last check. We don’t fill in a price from any other source.',
}

/**
 * The generic reason a mapped cell has no price: the SKU's row is gone (the
 * vendor delisted it), was never stored, or carries no price.
 */
export const NO_ROW_GAP =
  'No current price for this SKU. The vendor’s page didn’t list one at our last check.'

/**
 * Shown on a cell whose vendor sentence was not found on the page at the
 * last poll. The price is still the stored price for the mapped SKU; what
 * is in doubt is whether that SKU still answers the column's question.
 */
export const BASIS_STALE_NOTE =
  'At our last check, the vendor’s page no longer had the sentence this mapping quotes. The mapping is under review. The price shown is still this SKU’s price, but the vendor may now recommend a different model (full catalog).'
