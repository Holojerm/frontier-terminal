// The latency probes' fixed workload: one model per lab, one prompt, one
// output cap, once an hour (tasks/probes/latency.ts). Everything a probe
// sends is in this file, so a change to any of it is a visible series break:
// each row stores the model and route it used.
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
 * altogether (`billed_outside_cap`). With both, eight labs hourly come to
 * about $28 a month at 2026-11-19 list prices; the test in
 * layers/terminal/test/probes.test.ts holds the arithmetic.
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

export interface ProbeTarget {
  lab: LabId
  /** OpenRouter's model id. */
  model: string
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
  /**
   * Null when the model is the flagship cell of the price matrix
   * (utils/terminal-classes.ts). Otherwise why this model: the lab's docs name
   * no flagship and the owner picked it (2026-11-19).
   */
  note: string | null
  market: ProbeMarket
  /** USD per million tokens on OpenRouter when the target was set: the budget test's input, never shown. */
  list_price: { input: number; output: number }
}

export const PROBE_TARGETS: readonly ProbeTarget[] = [
  {
    lab: 'openai',
    model: 'openai/gpt-6.2-astra',
    provider: 'openai',
    effort: 'low',
    note: null,
    market: 'americas',
    list_price: { input: 8, output: 40 },
  },
  {
    lab: 'anthropic',
    model: 'anthropic/claude-opus-5.5',
    provider: 'anthropic',
    effort: 'low',
    note: null,
    market: 'americas',
    list_price: { input: 4, output: 20 },
  },
  {
    lab: 'google',
    model: 'google/gemini-4-carbon',
    provider: 'google-ai-studio',
    effort: 'low',
    note: null,
    market: 'americas',
    list_price: { input: 2, output: 10 },
  },
  {
    lab: 'xai',
    model: 'x-ai/grok-4.7',
    provider: 'xai',
    effort: 'low',
    // 2026-11-20: usage showed 674 reasoning tokens beside the 160 capped answer tokens, and a 1,261-token prompt.
    billed_outside_cap: { output: 700, prompt: 1260 },
    note: null,
    market: 'americas',
    list_price: { input: 2, output: 6 },
  },
  {
    lab: 'meta',
    model: 'meta/muse-wonder',
    provider: 'meta',
    effort: 'minimal',
    // 2026-11-20: at a cap of 160 the reply was 158 hidden reasoning tokens and no answer.
    reasoning_allowance: 320,
    note: null,
    market: 'americas',
    list_price: { input: 4, output: 20 },
  },
  {
    lab: 'mistral',
    model: 'mistralai/mistral-large-4-0',
    // Mistral has two standard endpoints there (mistral/zdr, mistral/eu); one is named so the series never mixes them.
    provider: 'mistral/zdr',
    // OpenRouter lists `none` for this model. Mistral's endpoint refused it on 2026-11-20
    // (400, "supported values: high, low, medium"), so the lowest it takes is `low`.
    effort: 'low',
    // 2026-11-20: at a cap of 480 the reply was 479 reasoning tokens and no answer, in 3.4 seconds.
    // The owner chose room for about 3,000 over dropping the lab (about $4 a month more).
    reasoning_allowance: 3000,
    note: 'Mistral’s docs name no flagship. We probe Large 4, its top-priced general text model.',
    market: 'europe',
    list_price: { input: 0.7, output: 2.1 },
  },
  {
    lab: 'alibaba',
    model: 'qwen/qwen4-max',
    provider: 'alibaba',
    effort: 'none',
    note: null,
    market: 'china',
    list_price: { input: 1.425, output: 4.275 },
  },
  {
    lab: 'moonshot',
    model: 'moonshotai/kimi-k3.1-pro',
    provider: 'moonshotai',
    effort: 'none',
    note: null,
    market: 'china',
    list_price: { input: 0.253, output: 10 },
  },
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
 * What a month of hourly probes costs at list prices when every probe spends
 * its whole cap, plus what an endpoint bills outside it.
 */
export function monthlyCostCeiling(targets: readonly ProbeTarget[] = PROBE_TARGETS): number {
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
