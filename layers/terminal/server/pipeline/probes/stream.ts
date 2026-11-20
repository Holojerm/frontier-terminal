// One latency probe: send the fixed request, time the stream, and say how it
// ended. Reads OpenRouter's chat-completions stream as documented
// (openrouter.ai/docs/api-reference/streaming): `data: {json}` lines,
// `: OPENROUTER PROCESSING` comments while it waits on the provider, a final
// chunk carrying `usage`, then `data: [DONE]`. A failure before the first byte
// is a JSON error body with the HTTP status; one after it is a chunk with a
// top-level `error` and the status stays 200.
//
// Timing on Workers: the clock only moves when I/O completes, which is exactly
// what a probe measures (each read of the stream is I/O), so `clock()` after a
// read is the arrival time of those bytes.

import { PROBE_ENDPOINT, PROBE_TIMEOUT_MS, probeRequestBody, type ProbeTarget } from './targets'

/**
 * How a probe ended. `setup` and `router` are ours or OpenRouter's, not the
 * lab's, and the daily reading leaves them out of its denominator.
 */
export type ProbeOutcome = 'ok' | 'rate_limited' | 'failed' | 'timeout' | 'setup' | 'router'

/** The outcomes that count as strain at the lab. */
export const STRAINED_OUTCOMES: readonly ProbeOutcome[] = ['rate_limited', 'failed', 'timeout']
/** The outcomes that say nothing about the lab. */
export const EXCLUDED_OUTCOMES: readonly ProbeOutcome[] = ['setup', 'router']

export interface StreamError {
  code: number | null
  message: string
  /** The provider's own error code, present only when the error came from the provider. */
  provider_code: string | null
}

export interface StreamState {
  /** clock() at the first chunk carrying answer or reasoning text. */
  first_token_at: number | null
  /** clock() at the last such chunk. */
  last_token_at: number | null
  /** Chunks that carried text. */
  token_chunks: number
  /** True when any reasoning text was streamed, so reasoning tokens arrived inside the timed span. */
  reasoning_streamed: boolean
  output_tokens: number | null
  reasoning_tokens: number | null
  cost_usd: number | null
  /** The `provider` field of the chunks: who OpenRouter says served it. */
  served_by: string | null
  generation_id: string | null
  finish_reason: string | null
  error: StreamError | null
  /** True once `data: [DONE]` arrived. */
  done: boolean
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** An error object from a JSON body or a stream chunk; null when `value` is not one. */
export function parseStreamError(value: unknown): StreamError | null {
  const error = record(value)
  if (!error) return null
  const metadata = record(error.metadata)
  const providerCode = metadata?.provider_code
  return {
    code: count(error.code) ?? (Number(error.code) || null),
    message: text(error.message).slice(0, 300),
    provider_code:
      typeof providerCode === 'string' || typeof providerCode === 'number'
        ? String(providerCode)
        : null,
  }
}

/** True when a delta carries text a reader would see arrive: answer or reasoning, not an encrypted blob. */
function deltaText(delta: Record<string, unknown>): { answer: boolean; reasoning: boolean } {
  const details = Array.isArray(delta.reasoning_details) ? delta.reasoning_details : []
  const reasoning =
    text(delta.reasoning) !== '' ||
    details.some((d) => {
      const item = record(d)
      return item !== null && (text(item.text) !== '' || text(item.summary) !== '')
    })
  return { answer: text(delta.content) !== '', reasoning }
}

/** Feed it the stream as it arrives; `state` is the reading so far. */
export function createStreamReader() {
  const state: StreamState = {
    first_token_at: null,
    last_token_at: null,
    token_chunks: 0,
    reasoning_streamed: false,
    output_tokens: null,
    reasoning_tokens: null,
    cost_usd: null,
    served_by: null,
    generation_id: null,
    finish_reason: null,
    error: null,
    done: false,
  }
  let buffer = ''

  const line = (raw: string, at: number) => {
    // A comment (`: OPENROUTER PROCESSING`) is a keep-alive, never a token.
    if (!raw.startsWith('data:')) return
    const data = raw.slice(5).trim()
    if (data === '[DONE]') {
      state.done = true
      return
    }
    let chunk: Record<string, unknown> | null
    try {
      chunk = record(JSON.parse(data))
    } catch {
      return
    }
    if (!chunk) return
    if (typeof chunk.id === 'string') state.generation_id ??= chunk.id
    if (typeof chunk.provider === 'string') state.served_by ??= chunk.provider
    const error = parseStreamError(chunk.error)
    if (error) state.error ??= error
    const choice = record(Array.isArray(chunk.choices) ? chunk.choices[0] : null)
    if (choice) {
      if (typeof choice.finish_reason === 'string') state.finish_reason = choice.finish_reason
      const delta = record(choice.delta)
      if (delta) {
        const seen = deltaText(delta)
        if (seen.reasoning) state.reasoning_streamed = true
        if (seen.answer || seen.reasoning) {
          state.first_token_at ??= at
          state.last_token_at = at
          state.token_chunks += 1
        }
      }
    }
    const usage = record(chunk.usage)
    if (usage) {
      state.output_tokens = count(usage.completion_tokens)
      state.reasoning_tokens =
        count(record(usage.completion_tokens_details)?.reasoning_tokens) ?? null
      state.cost_usd = count(usage.cost)
    }
  }

  return {
    state,
    /** `chunk` is decoded text, `at` the clock when it arrived. */
    push(chunk: string, at: number) {
      buffer += chunk
      let end = buffer.indexOf('\n')
      while (end !== -1) {
        line(buffer.slice(0, end).replace(/\r$/, ''), at)
        buffer = buffer.slice(end + 1)
        end = buffer.indexOf('\n')
      }
    },
    /** The stream closed: read a last line that had no newline. */
    end(at: number) {
      if (buffer !== '') line(buffer.replace(/\r$/, ''), at)
      buffer = ''
    },
  }
}

/** The shortest span between first and last token we will divide by. */
export const MIN_GENERATION_MS = 200

export interface ProbeMeasurement {
  ttft_ms: number | null
  total_ms: number
  output_tokens: number | null
  reasoning_tokens: number | null
  /**
   * Tokens that arrived after the first one, per second of the span between
   * the first and last token. Reasoning tokens count only when the reasoning
   * was streamed; hidden reasoning happened before the first token. Null when
   * the stream came in too few pieces or too short a span to divide.
   */
  tokens_per_second: number | null
}

export function measure(state: StreamState, startedAt: number, endedAt: number): ProbeMeasurement {
  const ttft = state.first_token_at === null ? null : state.first_token_at - startedAt
  let tps: number | null = null
  if (
    state.output_tokens !== null &&
    state.first_token_at !== null &&
    state.last_token_at !== null
  ) {
    const hidden = state.reasoning_streamed ? 0 : (state.reasoning_tokens ?? 0)
    const streamed = state.output_tokens - hidden
    const span = state.last_token_at - state.first_token_at
    if (streamed > 1 && span >= MIN_GENERATION_MS && state.token_chunks >= 3) {
      tps = Math.round(((streamed - 1) / (span / 1000)) * 100) / 100
    }
  }
  return {
    ttft_ms: ttft,
    total_ms: endedAt - startedAt,
    output_tokens: state.output_tokens,
    reasoning_tokens: state.reasoning_tokens,
    tokens_per_second: tps,
  }
}

export interface ProbeEnd {
  /** Null when no response arrived at all. */
  http_status: number | null
  /** The error body of a non-200 response. */
  body_error: StreamError | null
  state: StreamState
  timed_out: boolean
  /** A thrown fetch or read, as text. */
  thrown: string | null
}

/**
 * Whose problem it was. Any 429 is the lab's: OpenRouter sets no request cap
 * of its own on a paid model, so on a pinned route the limit is the
 * provider's (provider_code is kept where the body gives one). So is a
 * 502/503, or a 5xx naming the provider's code. Another 4xx is about our key,
 * credit, model id or request (`setup`), and so is a 200 whose stream we
 * could not read. A 500 with no provider code, or a
 * connection that never reached OpenRouter, is OpenRouter's (`router`).
 */
export function classify(end: ProbeEnd): { outcome: ProbeOutcome; detail: string | null } {
  if (end.timed_out) return { outcome: 'timeout', detail: 'no complete response in time' }
  if (end.http_status === null) {
    return { outcome: 'router', detail: (end.thrown ?? 'no response').slice(0, 300) }
  }
  const error = end.http_status === 200 ? end.state.error : end.body_error
  if (end.http_status !== 200 || error) {
    const code = error?.code ?? end.http_status
    const said = error?.message || `HTTP ${end.http_status}`
    const detail = `${code}${error?.provider_code ? ` (provider ${error.provider_code})` : ''}: ${said}`
    if (code === 429) return { outcome: 'rate_limited', detail }
    if (code === 408) return { outcome: 'timeout', detail }
    if (code === 502 || code === 503 || end.http_status === 200)
      return { outcome: 'failed', detail }
    if (code >= 500) return { outcome: error?.provider_code ? 'failed' : 'router', detail }
    return { outcome: 'setup', detail }
  }
  if (end.thrown) return { outcome: 'failed', detail: `stream broke: ${end.thrown}`.slice(0, 300) }
  if (!end.state.output_tokens || end.state.first_token_at === null) {
    // A clean 200 we could not read is our reader or the router, never evidence about the lab.
    return {
      outcome: 'setup',
      detail: 'unreadable reply: the stream ended with no tokens or no usage',
    }
  }
  return { outcome: 'ok', detail: null }
}

/** One read of the response body: when it arrived (ms after the request) and what it held. */
export type TraceRead = [offset_ms: number, text: string]

export interface ProbeResult extends ProbeMeasurement {
  outcome: ProbeOutcome
  detail: string | null
  http_status: number | null
  served_by: string | null
  generation_id: string | null
  finish_reason: string | null
  provider_code: string | null
  cost_usd: number | null
  /** ISO time the request was sent. */
  started_at: string
  /** Every read with its arrival time: the bytes each number above was derived from. */
  trace: TraceRead[]
}

/** The part of `fetch` a probe uses, so a test can stand in for it. */
export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>

export interface ProbeDeps {
  fetch: ProbeFetch
  /** Milliseconds; only differences are used. */
  clock: () => number
  now: () => Date
  apiKey: string
  timeoutMs?: number
}

/** Keeps a runaway stream from growing the stored trace without bound. */
const TRACE_MAX_BYTES = 256 * 1024

export async function runProbe(target: ProbeTarget, deps: ProbeDeps): Promise<ProbeResult> {
  const reader = createStreamReader()
  const trace: TraceRead[] = []
  const abort = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, deps.timeoutMs ?? PROBE_TIMEOUT_MS)

  const started_at = deps.now().toISOString()
  const startedAt = deps.clock()
  let http_status: number | null = null
  let body_error: StreamError | null = null
  let thrown: string | null = null
  let headerId: string | null = null
  try {
    const response = await deps.fetch(PROBE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(probeRequestBody(target)),
      signal: abort.signal,
    })
    http_status = response.status
    headerId = response.headers.get('x-generation-id')
    if (response.status !== 200) {
      const body = (await response.text()).slice(0, 4000)
      trace.push([deps.clock() - startedAt, body])
      try {
        body_error = parseStreamError(record(JSON.parse(body))?.error)
      } catch {
        body_error = null
      }
    } else if (response.body) {
      const stream = response.body.getReader()
      const decoder = new TextDecoder()
      let stored = 0
      for (;;) {
        const { done, value } = await stream.read()
        const at = deps.clock()
        if (done) break
        const piece = decoder.decode(value, { stream: true })
        reader.push(piece, at)
        if (stored < TRACE_MAX_BYTES) {
          trace.push([at - startedAt, piece])
          stored += piece.length
        }
      }
    }
  } catch (error) {
    thrown = String(error)
  } finally {
    clearTimeout(timer)
  }
  const endedAt = deps.clock()
  reader.end(endedAt)

  const state = reader.state
  const { outcome, detail } = classify({
    http_status,
    body_error,
    state,
    timed_out: timedOut,
    thrown,
  })
  const measured = measure(state, startedAt, endedAt)
  return {
    ...measured,
    // A throughput from a stream that then failed is not a reading of anything.
    tokens_per_second: outcome === 'ok' ? measured.tokens_per_second : null,
    outcome,
    detail,
    http_status,
    served_by: state.served_by,
    generation_id: state.generation_id ?? headerId,
    finish_reason: state.finish_reason,
    provider_code: (http_status === 200 ? state.error : body_error)?.provider_code ?? null,
    cost_usd: state.cost_usd,
    started_at,
    trace,
  }
}
