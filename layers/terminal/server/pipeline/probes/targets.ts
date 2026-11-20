// The latency probes' fixed workload: one model per lab, one prompt, one
// output cap, once an hour (tasks/probes/latency.ts). Everything a probe
// sends is in this file but the model, which for a lab's flagship cell is
// chosen on every run (probes/resolve.ts), so the probes follow a new
// flagship without an edit here. A change to any of it is a visible series
// break: each row stores the model and route it used.
//
// Route: OpenRouter, pinned to the lab's own endpoint with fallbacks off
// (owner's decision, 2026-11-19). One key the Worker already has, at the cost
// of one hop in front of every lab and no reading for a lab OpenRouter serves
// only through third parties.

import type { LabId } from '../../../shared/utils/terminal-types'

export const PROBE_ROUTE = 'openrouter'
export const PROBE_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

/** A counting prompt: the output is long enough to hit the cap on every model, and the same every hour. */
export const PROBE_PROMPT =
  'Count from one to three hundred in English words, separated by commas. Output only the words.'

/**
 * The answer every probe asks for. Most endpoints count reasoning tokens
 * against the cap, so a target whose reasoning would use it up carries a
 * `reasoning_allowance` on top, and xAI bills its reasoning outside the cap
 * altogether (`billed_outside_cap`). With both, seven labs hourly come to
 * about $23 a month at 2026-11-20 list prices, under PROBE_MONTHLY_BUDGET_USD;
 * the test in layers/terminal/test/probes.test.ts holds the arithmetic.
 */
export const PROBE_MAX_TOKENS = 160

/** A probe that has not finished by now is recorded as a timeout. */
export const PROBE_TIMEOUT_MS = 45_000

/** Where a lab's working day falls, for the peak and off-peak hours below. */
export type ProbeMarket = 'americas' | 'europe' | 'china'

export interface ProbeWindow {
  /** UTC hours (0–23) counted as the working day. */
  peak: readonly number[]
  /** UTC hours of the same UTC date counted as the night. */
  offpeak: readonly number[]
  label: string
}

/**
 * Fixed UTC hours, six each, so a day's reading never depends on what the
 * day's own numbers looked like. They are a first guess at when each lab's
 * fleet is busiest, to be checked against a month of readings.
 */
export const PROBE_WINDOWS: Record<ProbeMarket, ProbeWindow> = {
  americas: {
    peak: [15, 16, 17, 18, 19, 20],
    offpeak: [3, 4, 5, 6, 7, 8],
    label: 'peak 15:00–21:00 UTC (the North American working day), off-peak 03:00–09:00 UTC',
  },
  europe: {
    peak: [8, 9, 10, 11, 12, 13],
    offpeak: [0, 1, 2, 3, 4, 5],
    label: 'peak 08:00–14:00 UTC (the European working day), off-peak 00:00–06:00 UTC',
  },
  china: {
    peak: [2, 3, 4, 5, 6, 7],
    offpeak: [16, 17, 18, 19, 20, 21],
    label: 'peak 02:00–08:00 UTC (the working day in China), off-peak 16:00–22:00 UTC',
  },
}

interface ProbeTargetBase {
  lab: LabId
  /**
   * OpenRouter's provider slug for the lab's own endpoint: the only one the
   * request may use. A bare slug never matches a priority or flex tier, so
   * these are the standard tier.
   */
  provider: string
  /**
   * The lowest reasoning effort the endpoint accepts (OpenRouter's model list,
   * `reasoning.supported_efforts`, read 2026-11-19, corrected by what the
   * endpoint itself answered on 2026-11-20). Six of these models reason
   * before they answer, so their first token waits on it.
   */
  effort: 'none' | 'minimal' | 'low'
  /**
   * Output tokens added to the cap for reasoning the endpoint counts against
   * it, so the cap is not spent before the answer starts.
   */
  reasoning_allowance?: number
  /**
   * Output tokens the endpoint bills beyond the cap, and prompt tokens it
   * bills beyond ours, as seen in its usage. For the budget only.
   */
  billed_outside_cap?: { output: number; prompt: number }
  market: ProbeMarket
}

/** USD per million tokens on OpenRouter: the budget's input, never shown. */
export interface ProbePrice {
  input: number
  output: number
}

/**
 * The flagship cell of the price matrix (utils/terminal-classes.ts). The
 * model is chosen on every run, from the class map in effect and the newest
 * OpenRouter catalog we stored, and so is its price (probes/resolve.ts).
 */
export interface DerivedProbeTarget extends ProbeTargetBase {
  note: null
}

/** A lab whose docs name no flagship: the owner picked the model, and it stays pinned. */
export interface PinnedProbeTarget extends ProbeTargetBase {
  /** OpenRouter's model id. */
  model: string
  /** Why this model. */
  note: string
  /** USD per million tokens on OpenRouter when the target was set. */
  list_price: ProbePrice
}

export type ProbeTargetSpec = DerivedProbeTarget | PinnedProbeTarget

/** One run's target, with its model and price settled (probes/resolve.ts). */
export interface ProbeTarget extends ProbeTargetBase {
  /** OpenRouter's model id. */
  model: string
  note: string | null
  list_price: ProbePrice
  /**
   * How a derived target's model was chosen, kept with each probe's trace in
   * R2; null for a pinned one.
   */
  chosen_from: {
    /** The class map's flagship slug: a family, not always the exact id. */
    family: string
    catalog_source_url: string
    catalog_fetched_at: string
  } | null
}

/**
 * Each probed lab's workload. Every target today is a flagship cell, so its
 * model is derived; a pinned target (note set, model and list_price given)
 * is for a lab whose docs name no flagship.
 */
export const PROBE_TARGETS: readonly ProbeTargetSpec[] = [
  { lab: 'openai', provider: 'openai', effort: 'low', note: null, market: 'americas' },
  { lab: 'anthropic', provider: 'anthropic', effort: 'low', note: null, market: 'americas' },
  { lab: 'google', provider: 'google-ai-studio', effort: 'low', note: null, market: 'americas' },
  {
    lab: 'xai',
    provider: 'xai',
    effort: 'low',
    // 2026-11-20: usage showed 674 reasoning tokens beside the 160 capped answer tokens, and a 1,261-token prompt.
    billed_outside_cap: { output: 700, prompt: 1260 },
    note: null,
    market: 'americas',
  },
  {
    lab: 'meta',
    provider: 'meta',
    effort: 'minimal',
    // 2026-11-20: at a cap of 160 the reply was 158 hidden reasoning tokens and no answer.
    reasoning_allowance: 320,
    note: null,
    market: 'americas',
  },
  { lab: 'alibaba', provider: 'alibaba', effort: 'none', note: null, market: 'china' },
  { lab: 'moonshot', provider: 'moonshotai', effort: 'none', note: null, market: 'china' },
]

export interface ProbeGap {
  lab: LabId
  /** The model the owner chose for this lab, unprobed. */
  model: string
  reason: string
}

/** A lab we do not probe is a stated gap, never a missing row. */
export const PROBE_GAPS: readonly ProbeGap[] = [
  {
    lab: 'deepseek',
    model: 'deepseek/deepseek-v4-pro',
    reason:
      'OpenRouter serves DeepSeek V4 Pro only through other companies’ hardware, not DeepSeek’s own endpoint. A probe there would measure the host, so we take no reading.',
  },
  {
    lab: 'mistral',
    model: 'mistralai/mistral-large-4-0',
    // Dropped 2026-11-20 (owner's decision, #486): at effort `low` on mistral/zdr the reply was
    // cap − 1 reasoning tokens at a cap of 480 and again at 3,160, so more room never bought an answer.
    reason:
      'Mistral’s own endpoint spends the whole output cap on reasoning, even at its lowest reasoning setting and a cap of 3,160 tokens, so a probe never gets an answer to time. We take no reading.',
  },
]

/** The request one probe sends. No temperature: several of these models refuse one. */
export function probeRequestBody(target: ProbeTarget) {
  return {
    model: target.model,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
    stream: true,
    max_tokens: PROBE_MAX_TOKENS + (target.reasoning_allowance ?? 0),
    reasoning: { effort: target.effort },
    provider: { only: [target.provider], allow_fallbacks: false },
  }
}

/** UTC hours a calendar month of hourly probes covers, for the budget arithmetic. */
const HOURS_PER_MONTH = 24 * 30.5
/** The prompt's size with chat framing, rounded up. */
const PROMPT_TOKENS = 40

/**
 * What a month of hourly probes may cost at list prices. A run probes a
 * derived target only while the month, at that run's catalog prices, stays
 * under it (probes/resolve.ts); the rest are skipped and spooled.
 */
export const PROBE_MONTHLY_BUDGET_USD = 24

/**
 * What a month of hourly probes costs at list prices when every probe spends
 * its whole cap, plus what an endpoint bills outside it.
 */
export function monthlyCostCeiling(
  targets: readonly Pick<
    ProbeTarget,
    'list_price' | 'reasoning_allowance' | 'billed_outside_cap'
  >[],
): number {
  return targets.reduce((sum, t) => {
    const prompt = PROMPT_TOKENS + (t.billed_outside_cap?.prompt ?? 0)
    const output =
      PROBE_MAX_TOKENS + (t.reasoning_allowance ?? 0) + (t.billed_outside_cap?.output ?? 0)
    return (
      sum +
      (HOURS_PER_MONTH * (prompt * t.list_price.input + output * t.list_price.output)) / 1_000_000
    )
  }, 0)
}
