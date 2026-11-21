import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { OPENROUTER_KEY_UNSET } from '../server/pipeline/fetch'
import {
  MIN_WINDOW_SAMPLES,
  dayReading,
  peakToOffpeak,
  rollProbeDays,
  strainedShare,
  type ProbePoint,
} from '../server/pipeline/probes/daily'
import { parseOpenRouter } from '../server/pipeline/parsers/openrouter'
import {
  PROBE_MODEL_UNRESOLVED_KIND,
  PROBE_OVER_BUDGET_KIND,
  matchFlagship,
  resolveProbeTargets,
  slugTokens,
  type ProbeCatalog,
} from '../server/pipeline/probes/resolve'
import {
  PRIMARY_PLACEMENT,
  PROBE_PLACEMENTS,
  PROBE_PLACEMENT_FAILED_KIND,
  PROBE_RUN_PATH,
  PROBE_UNPINNED_KIND,
  insideDurableObject,
  probeObjectName,
  type ProbeNamespace,
} from '../server/pipeline/probes/placement'
import { probeOrigin, probeRawKey, runProbes } from '../server/pipeline/probes/run'
import {
  classify,
  createStreamReader,
  measure,
  rateLimitHeaders,
  responseHeaders,
  runProbe,
  servedByPinned,
  type ProbeEnd,
  type ProbeFetch,
  type StreamState,
} from '../server/pipeline/probes/stream'
import {
  PROBE_ENDPOINT,
  PROBE_GAPS,
  PROBE_MAX_TOKENS,
  PROBE_MONTHLY_BUDGET_USD,
  PROBE_TARGETS,
  PROBE_WINDOWS,
  monthlyCostCeiling,
  probeRequestBody,
  type PinnedProbeTarget,
  type ProbeTarget,
} from '../server/pipeline/probes/targets'
import { MODEL_CLASS_MAP } from '../server/utils/terminal-classes'
import { queryContext } from '../server/utils/terminal-db'
import { PROBE_BINDING, dispatchPinnedProbes } from '../server/utils/probe-runner'
import { probesStamp, queryProbes } from '../server/utils/terminal-probes'
import { PROVIDER_ORDER } from '../server/utils/terminal-sources'
import { fixtureText } from './pipeline/fixtures'

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')

// OpenRouter's /api/v1/models as served 2026-11-20T22:14Z, trimmed to the
// tracked labs' prefixes and to the fields the parser reads plus name and
// created. Not in fixtures/manifest.json: openrouter-models' registered
// fixture is the 2026-08-25 capture the price tests are pinned to.
const CATALOG_PATH = 'fixtures/pricing/openrouter-models.2026-11-20.json'
const CATALOG_FETCHED_AT = '2026-11-20T22:14:00.000Z'
const CATALOG_TEXT = fixtureText(CATALOG_PATH)
const CATALOG: ProbeCatalog = {
  rows: parseOpenRouter(CATALOG_TEXT, {
    source_url: 'https://openrouter.ai/api/v1/models',
    fetched_at: CATALOG_FETCHED_AT,
  }).rows,
  source_url: 'https://openrouter.ai/api/v1/models',
  fetched_at: CATALOG_FETCHED_AT,
}
const RESOLVED = resolveProbeTargets(PROBE_TARGETS, MODEL_CLASS_MAP, CATALOG)
const RESOLVED_TARGETS: readonly ProbeTarget[] = RESOLVED.targets

beforeEach(async () => {
  await db.delete(schema.latencyProbes)
  await db.delete(schema.probeDays)
  await db.delete(schema.opsEvents)
  await db.delete(schema.classMapDecisions)
  await db.delete(schema.sourceRuns)
  await db.delete(schema.snapshots)
})

// ---- the stream, as OpenRouter documents it ---------------------------------

const chunk = (delta: object, extra: object = {}) =>
  `data: ${JSON.stringify({
    id: 'gen-1',
    object: 'chat.completion.chunk',
    provider: 'OpenAI',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}\n\n`

const usageChunk = (completion: number, reasoning = 0) =>
  `data: ${JSON.stringify({
    id: 'gen-1',
    provider: 'OpenAI',
    choices: [{ index: 0, delta: { content: '' }, finish_reason: 'length' }],
    usage: {
      prompt_tokens: 31,
      completion_tokens: completion,
      completion_tokens_details: { reasoning_tokens: reasoning },
      cost: 0.0066,
    },
  })}\n\n`

/** [arrival ms, text]: a stream as a list of reads. */
type Read = [number, string]

const GOOD: Read[] = [
  [120, ': OPENROUTER PROCESSING\n\n'],
  [300, ': OPENROUTER PROCESSING\n\n'],
  [410, chunk({ role: 'assistant', content: '' })],
  [450, chunk({ content: 'one,' })],
  [700, chunk({ content: ' two,' }) + chunk({ content: ' three,' })],
  [1450, chunk({ content: ' four' })],
  [1460, usageChunk(160)],
  [1461, 'data: [DONE]\n\n'],
]

function read(reads: readonly Read[]): StreamState {
  const reader = createStreamReader()
  for (const [at, text] of reads) reader.push(text, at)
  reader.end(reads.at(-1)?.[0] ?? 0)
  return reader.state
}

describe('the stream reader', () => {
  it('times the first text, not a keep-alive comment or the empty role chunk', () => {
    const state = read(GOOD)
    expect(state).toMatchObject({
      first_token_at: 450,
      last_token_at: 1450,
      token_chunks: 4,
      output_tokens: 160,
      reasoning_tokens: 0,
      cost_usd: 0.0066,
      served_by: 'OpenAI',
      generation_id: 'gen-1',
      finish_reason: 'length',
      error: null,
      done: true,
    })
  })

  it('reads a line split across two reads, and CRLF line ends', () => {
    const line = chunk({ content: 'one' }).replaceAll('\n', '\r\n')
    const state = read([
      [100, line.slice(0, 40)],
      [180, line.slice(40)],
      [200, usageChunk(5).trimEnd()],
    ])
    expect(state.first_token_at).toBe(180)
    // The last line had no newline; end() still reads it.
    expect(state.output_tokens).toBe(5)
  })

  it('times the first answer text, whether the reasoning before it was streamed or hidden', () => {
    const hidden = read([
      [200, chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'AAAA' }] })],
      [900, chunk({ content: 'one' })],
    ])
    expect(hidden).toMatchObject({ first_token_at: 900, reasoning_streamed: false })
    const shown = read([
      [200, chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'Counting.' }] })],
      [900, chunk({ content: 'one' })],
    ])
    expect(shown).toMatchObject({ first_token_at: 900, token_chunks: 1, reasoning_streamed: true })
    expect(read([[150, chunk({ reasoning: 'Counting.' })]])).toMatchObject({
      first_token_at: null,
      reasoning_streamed: true,
    })
  })

  it('keeps a mid-stream error with the provider’s own code', () => {
    const state = read([
      [300, chunk({ content: 'one,' })],
      [
        900,
        chunk(
          { content: '' },
          {
            error: {
              code: 429,
              message: 'Rate limit exceeded',
              metadata: { error_type: 'rate_limit_exceeded', provider_code: 'rate_limit_error' },
            },
          },
        ),
      ],
    ])
    expect(state.error).toEqual({
      code: 429,
      message: 'Rate limit exceeded',
      provider_code: 'rate_limit_error',
    })
  })

  it('skips a data line that is not JSON', () => {
    expect(read([[100, 'data: {not json\n\n'], ...GOOD]).output_tokens).toBe(160)
  })
})

describe('measure', () => {
  it('divides the tokens after the first by the span from first to last token', () => {
    // 159 tokens over 1.000 s.
    expect(measure(read(GOOD), 0, 1461)).toEqual({
      ttft_ms: 450,
      total_ms: 1461,
      output_tokens: 160,
      reasoning_tokens: 0,
      tokens_per_second: 159,
    })
  })

  it('leaves hidden reasoning tokens out of throughput, since they came before the first token', () => {
    const reads = [...GOOD.slice(0, 6), [1460, usageChunk(160, 60)] as Read]
    // 100 visible tokens, 99 after the first, over 1.000 s.
    expect(measure(read(reads), 0, 1461).tokens_per_second).toBe(99)
  })

  // The shape of xAI's reply on 2026-11-20: reasoning text for seven seconds,
  // then the answer, and a usage that bills the reasoning beyond the cap.
  const REASONED: Read[] = [
    [3006, chunk({ reasoning: 'The user wants' })],
    [6000, chunk({ reasoning: ' a count to three hundred.' })],
    [10239, chunk({ content: 'one,' })],
    [10600, chunk({ content: ' two,' })],
    [11239, chunk({ content: ' three' })],
    [11300, usageChunk(834, 674)],
  ]

  it('times a reply with streamed reasoning from its answer, on answer tokens alone', () => {
    // 160 answer tokens, 159 after the first, over 1.000 s.
    expect(measure(read(REASONED), 0, 11354)).toMatchObject({
      ttft_ms: 10239,
      output_tokens: 834,
      reasoning_tokens: 674,
      tokens_per_second: 159,
    })
  })

  it('gives no throughput when streamed reasoning cannot be told from the answer', () => {
    const unstated = [
      ...REASONED.slice(0, 5),
      [11300, usageChunk(834).replace('"reasoning_tokens":0', '"reasoning_tokens":null')] as Read,
    ]
    expect(measure(read(unstated), 0, 11354)).toMatchObject({
      ttft_ms: 10239,
      tokens_per_second: null,
    })
  })

  it('gives no throughput for a reply that arrived in one piece', () => {
    const state = read([
      [800, chunk({ content: 'one, two, three' })],
      [805, usageChunk(160)],
    ])
    expect(measure(state, 0, 805)).toMatchObject({ ttft_ms: 800, tokens_per_second: null })
  })

  it('measures from the request, whatever the clock’s origin', () => {
    const shifted = GOOD.map(([at, text]): Read => [at + 5000, text])
    expect(measure(read(shifted), 5000, 6461)).toMatchObject({ ttft_ms: 450, total_ms: 1461 })
  })
})

// The shape of Meta's reply on 2026-11-20 at a cap of 160: one encrypted
// reasoning blob, no answer text, finish_reason length.
const ALL_REASONING: Read[] = [
  [1649, ': OPENROUTER PROCESSING\n\n'],
  [
    3264,
    chunk({
      content: '',
      role: 'assistant',
      reasoning: null,
      reasoning_details: [{ type: 'reasoning.encrypted', data: 'Q-PaDgHx' }],
    }),
  ],
  [3284, usageChunk(160, 158)],
  [3287, 'data: [DONE]\n\n'],
]

describe('classify', () => {
  const state = read(GOOD)
  const empty = read([])
  const end = (over: Partial<ProbeEnd>): ProbeEnd => ({
    http_status: 200,
    body_error: null,
    state,
    timed_out: false,
    thrown: null,
    ...over,
  })
  const body = (code: number, provider_code: string | null = null) =>
    end({ http_status: code, state: empty, body_error: { code, message: 'said', provider_code } })

  it.each([
    ['a complete stream', end({}), 'ok'],
    ['402, out of credit', body(402), 'setup'],
    ['401, a bad key', body(401), 'setup'],
    ['404, no endpoint matches the pin', body(404), 'setup'],
    ['400, a refused request', body(400), 'setup'],
    ['429 with the provider’s code', body(429, '429'), 'rate_limited'],
    ['429 with no provider code', body(429), 'rate_limited'],
    ['502 passing through the provider’s 429', body(502, '429'), 'rate_limited'],
    [
      'a 502 that says it was rate limited upstream',
      end({
        http_status: 502,
        state: empty,
        body_error: {
          code: 502,
          message: 'Provider is rate-limited upstream',
          provider_code: null,
        },
      }),
      'rate_limited',
    ],
    ['502, the model is down', body(502), 'failed'],
    ['503, the pinned provider is unavailable', body(503), 'failed'],
    ['500 with no provider code', body(500), 'router'],
    ['408', body(408), 'timeout'],
    ['our own timeout', end({ timed_out: true, state: empty }), 'timeout'],
    [
      'no response at all',
      end({ http_status: null, state: empty, thrown: 'TypeError: fetch failed' }),
      'router',
    ],
    ['a 200 that ends with no usage', end({ state: read(GOOD.slice(0, 6)) }), 'setup'],
    ['a 200 whose cap went to hidden reasoning', end({ state: read(ALL_REASONING) }), 'setup'],
    [
      'a 429 mid-stream',
      end({ state: { ...state, error: { code: 429, message: 'slow down', provider_code: null } } }),
      'rate_limited',
    ],
    [
      'an error mid-stream',
      end({
        state: { ...state, error: { code: 502, message: 'overloaded', provider_code: null } },
      }),
      'failed',
    ],
    ['a read that threw mid-stream', end({ thrown: 'Error: connection reset' }), 'failed'],
  ] as const)('%s is %s', (_name, input, outcome) => {
    expect(classify(input).outcome).toBe(outcome)
  })

  it('says what happened in the detail', () => {
    expect(classify(body(429, 'overloaded_error')).detail).toBe(
      '429 (provider overloaded_error): said',
    )
    expect(classify(end({})).detail).toBeNull()
    expect(classify(end({ state: read(ALL_REASONING) })).detail).toBe(
      'no answer text: the output cap went to reasoning (158 of 160 tokens)',
    )
    expect(classify(end({ state: read(GOOD.slice(0, 6)) })).detail).toBe(
      'unreadable reply: the stream ended with no tokens or no usage',
    )
  })
})

// ---- one probe ---------------------------------------------------------------

/** A clock a fake response moves as it is read. */
function fakeClock(start = 1_000_000) {
  let at = start
  return { clock: () => at, set: (ms: number) => (at = start + ms), start }
}

function streamResponse(reads: readonly Read[], clock: ReturnType<typeof fakeClock>): Response {
  const encoder = new TextEncoder()
  let i = 0
  return new Response(
    new ReadableStream(
      {
        pull(controller) {
          const next = reads[i++]
          if (!next) return controller.close()
          clock.set(next[0])
          controller.enqueue(encoder.encode(next[1]))
        },
        // No read-ahead: the clock moves when the probe asks for the next read.
      },
      { highWaterMark: 0 },
    ),
    {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-generation-id': 'gen-h',
        'x-ratelimit-remaining-requests': '4999',
        'retry-after': '0',
        'set-cookie': '__cf_bm=secret',
      },
    },
  )
}

const TARGET = RESOLVED_TARGETS[0]!
const NOW = new Date('2026-11-20T15:07:00.000Z')

describe('runProbe', () => {
  it('sends the fixed request pinned to the lab’s own endpoint, and times the reply', async () => {
    const clock = fakeClock()
    const calls: { url: string; init: RequestInit }[] = []
    const fetcher: ProbeFetch = async (url, init) => {
      calls.push({ url, init })
      return streamResponse(GOOD, clock)
    }
    const result = await runProbe(TARGET, {
      fetch: fetcher,
      clock: clock.clock,
      now: () => NOW,
      apiKey: 'or-test',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(PROBE_ENDPOINT)
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer or-test')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: 'openai/gpt-6.2-astra',
      messages: [{ role: 'user', content: expect.stringContaining('Count from one') }],
      stream: true,
      max_tokens: PROBE_MAX_TOKENS,
      reasoning: { effort: 'low' },
      provider: { only: ['openai'], allow_fallbacks: false },
    })
    expect(result).toMatchObject({
      outcome: 'ok',
      detail: null,
      http_status: 200,
      started_at: NOW.toISOString(),
      ttft_ms: 450,
      output_tokens: 160,
      tokens_per_second: 159,
      served_by: 'OpenAI',
      generation_id: 'gen-1',
      finish_reason: 'length',
      cost_usd: 0.0066,
      served_by_pinned: true,
      rate_limit_headers: '{"retry-after":"0","x-ratelimit-remaining-requests":"4999"}',
    })
    expect(result.response_headers).toMatchObject({ 'x-generation-id': 'gen-h' })
    expect(result.response_headers).not.toHaveProperty('set-cookie')
    // Every read is kept with its arrival time, and none of it is the key.
    expect(result.trace.map(([at]) => at)).toEqual(GOOD.map(([at]) => at))
    expect(JSON.stringify(result.trace)).not.toContain('or-test')
  })

  it('reads an error body, and gives a failed probe no throughput', async () => {
    const clock = fakeClock()
    const result = await runProbe(TARGET, {
      fetch: async () =>
        Response.json(
          {
            error: {
              code: 429,
              message: 'Provider returned error',
              metadata: { provider_code: 'rate_limit_exceeded' },
            },
          },
          { status: 429 },
        ),
      clock: clock.clock,
      now: () => NOW,
      apiKey: 'or-test',
    })
    expect(result).toMatchObject({
      outcome: 'rate_limited',
      http_status: 429,
      provider_code: 'rate_limit_exceeded',
      ttft_ms: null,
      tokens_per_second: null,
    })
  })

  it('records a timeout when the reply never finishes', async () => {
    const clock = fakeClock()
    const result = await runProbe(TARGET, {
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
        }),
      clock: clock.clock,
      now: () => NOW,
      apiKey: 'or-test',
      timeoutMs: 10,
    })
    expect(result).toMatchObject({ outcome: 'timeout', http_status: null, ttft_ms: null })
  })
})

// ---- the daily reading -------------------------------------------------------

const AMERICAS = PROBE_WINDOWS.americas
const point = (hour: number, over: Partial<ProbePoint> = {}): ProbePoint => ({
  started_at: `2026-11-20T${String(hour).padStart(2, '0')}:07:00.000Z`,
  model: TARGET.model,
  route: 'openrouter',
  outcome: 'ok',
  ttft_ms: 500,
  tokens_per_second: 100,
  source_url: PROBE_ENDPOINT,
  ...over,
})

describe('dayReading', () => {
  it('is null for a day with no probes', () => {
    expect(dayReading([], AMERICAS)).toBeNull()
  })

  it('reads peak against off-peak from the lab’s fixed hours', () => {
    const reading = dayReading(
      [
        ...AMERICAS.peak.map((h, i) => point(h, { tokens_per_second: 60 + i, ttft_ms: 900 })),
        ...AMERICAS.offpeak.map((h, i) => point(h, { tokens_per_second: 100 + i, ttft_ms: 400 })),
        point(12, { tokens_per_second: 999 }),
      ],
      AMERICAS,
    )!
    expect(reading).toMatchObject({
      probes: 13,
      ok: 13,
      rate_limited: 0,
      failed: 0,
      excluded: 0,
      peak_n: 6,
      offpeak_n: 6,
      peak_tps: 62.5,
      offpeak_tps: 102.5,
      peak_ttft_ms: 900,
      offpeak_ttft_ms: 400,
      fetched_at: '2026-11-20T20:07:00.000Z',
    })
    expect(peakToOffpeak(reading)).toBe(0.61)
  })

  it('counts rate limits, errors and timeouts as strain, and leaves our own failures out', () => {
    const reading = dayReading(
      [
        point(15),
        point(16, { outcome: 'rate_limited', tokens_per_second: null, ttft_ms: null }),
        point(17, { outcome: 'failed', tokens_per_second: null, ttft_ms: null }),
        point(18, { outcome: 'timeout', tokens_per_second: null, ttft_ms: null }),
        point(19, { outcome: 'setup', tokens_per_second: null, ttft_ms: null }),
        point(20, { outcome: 'router', tokens_per_second: null, ttft_ms: null }),
      ],
      AMERICAS,
    )!
    expect(reading).toMatchObject({ probes: 4, ok: 1, rate_limited: 1, failed: 2, excluded: 2 })
    expect(strainedShare(reading)).toBe(0.75)
  })

  it('gives no window median under the minimum sample', () => {
    const few = AMERICAS.peak.slice(0, MIN_WINDOW_SAMPLES - 1).map((h) => point(h))
    const reading = dayReading(few, AMERICAS)!
    expect(reading.peak_n).toBe(MIN_WINDOW_SAMPLES - 1)
    expect(reading.peak_tps).toBeNull()
    expect(peakToOffpeak(reading)).toBeNull()
    // The day's own median still stands.
    expect(reading.tps).toBe(100)
  })

  it('reads a day that changed model from the newest model only', () => {
    const reading = dayReading(
      [point(3, { model: 'openai/old', tokens_per_second: 10 }), point(15), point(16), point(17)],
      AMERICAS,
    )!
    expect(reading).toMatchObject({ model: TARGET.model, probes: 3, peak_tps: 100, tps: 100 })
  })

  it('has no share to report when every probe was ours to fix', () => {
    const reading = dayReading([point(15, { outcome: 'setup' })], AMERICAS)!
    expect(strainedShare(reading)).toBeNull()
  })
})

// ---- the run, the rollup and the route ---------------------------------------

function fakeRaw() {
  const puts = new Map<string, string>()
  return {
    puts,
    store: {
      put: async (key: string, body: string) => {
        puts.set(key, body)
      },
    },
  }
}

/** A stored openrouter-models snapshot and its good run, as a poll leaves them; returns the R2 reader. */
async function seedCatalog(text: string = CATALOG_TEXT) {
  const raw_key = 'raw/openrouter-models/catalog.json'
  await db.insert(schema.snapshots).values({
    id: 'snap-or',
    source_id: 'openrouter-models',
    content_hash: 'h',
    raw_key,
    http_status: 200,
    bytes: text.length,
    source_url: CATALOG.source_url,
    fetched_at: CATALOG_FETCHED_AT,
  })
  await db.insert(schema.sourceRuns).values({
    id: 'run-or',
    scope: 'six-hourly',
    source_id: 'openrouter-models',
    started_at: CATALOG_FETCHED_AT,
    status: 'ok',
    snapshot_id: 'snap-or',
    added: 0,
    removed: 0,
    modified: 0,
    source_url: CATALOG.source_url,
  })
  return async (key: string) => (key === raw_key ? text : null)
}

const noRaw = async () => null

describe('runProbes', () => {
  it('probes nothing and stores nothing without a key', async () => {
    const raw = fakeRaw()
    const report = await runProbes(db, {
      fetch: async () => {
        throw new Error('must not be called')
      },
      clock: () => 0,
      now: () => NOW,
      apiKey: ' ',
      raw: raw.store,
      readRaw: noRaw,
      ranFrom: 'local',
      placement: 'unpinned',
    })
    expect(report).toEqual({
      skipped: OPENROUTER_KEY_UNSET,
      probes: [],
      unprobed: [],
      days_rolled: 0,
    })
    expect(await db.select().from(schema.opsEvents)).toEqual([])
    expect(await db.select().from(schema.latencyProbes)).toEqual([])
    expect(raw.puts.size).toBe(0)
  })

  it('stores a row and a trace per lab, one request at a time, then rolls the day', async () => {
    const raw = fakeRaw()
    const clock = fakeClock()
    let open = 0
    let widest = 0
    const fetcher: ProbeFetch = async (_url, init) => {
      open += 1
      widest = Math.max(widest, open)
      const model = JSON.parse(init.body as string).model as string
      await Promise.resolve()
      open -= 1
      // Anthropic is out of credit on our side; xAI is rate limited at xAI.
      if (model.startsWith('anthropic/')) {
        return Response.json(
          { error: { code: 402, message: 'Insufficient credits' } },
          { status: 402 },
        )
      }
      if (model.startsWith('x-ai/')) {
        return Response.json(
          { error: { code: 429, message: 'limited', metadata: { provider_code: '429' } } },
          { status: 429 },
        )
      }
      return streamResponse(GOOD, clock)
    }
    const report = await runProbes(db, {
      fetch: fetcher,
      clock: clock.clock,
      now: () => NOW,
      apiKey: 'or-test',
      raw: raw.store,
      readRaw: await seedCatalog(),
      ranFrom: 'cloudflare:EWR',
      placement: 'enam',
    })
    expect(widest).toBe(1)
    expect(report).toMatchObject({ placement: 'enam', ran_from: 'cloudflare:EWR' })
    expect(report.unprobed).toEqual([])
    expect(report.probes.map((p) => [p.lab, p.outcome])).toEqual(
      PROBE_TARGETS.map((t) => [
        t.lab,
        t.lab === 'anthropic' ? 'setup' : t.lab === 'xai' ? 'rate_limited' : 'ok',
      ]),
    )
    expect(report.days_rolled).toBe(PROBE_TARGETS.length)

    const rows = await db.select().from(schema.latencyProbes)
    expect(rows).toHaveLength(PROBE_TARGETS.length)
    const openai = rows.find((r) => r.lab === 'openai')!
    expect(openai).toMatchObject({
      model: 'openai/gpt-6.2-astra',
      route: 'openrouter',
      provider: 'openai',
      served_by: 'OpenAI',
      outcome: 'ok',
      http_status: 200,
      ttft_ms: 450,
      output_tokens: 160,
      tokens_per_second: 159,
      ran_from: 'cloudflare:EWR',
      placement: 'enam',
      served_by_pinned: true,
      rate_limit_headers: '{"retry-after":"0","x-ratelimit-remaining-requests":"4999"}',
      source_url: PROBE_ENDPOINT,
      fetched_at: NOW.toISOString(),
      raw_key: probeRawKey('openai', NOW.toISOString()),
    })
    const stored = JSON.parse(raw.puts.get(openai.raw_key!)!)
    expect(stored).toMatchObject({ ran_from: 'cloudflare:EWR', placement: 'enam' })
    expect(stored.response_headers).toMatchObject({ 'x-ratelimit-remaining-requests': '4999' })
    expect(stored.response_headers).not.toHaveProperty('set-cookie')
    expect(stored.request.provider).toEqual({ only: ['openai'], allow_fallbacks: false })
    expect(stored.chosen_from).toEqual({
      family: 'gpt-6-astra',
      catalog_source_url: 'https://openrouter.ai/api/v1/models',
      catalog_fetched_at: CATALOG_FETCHED_AT,
    })
    expect(stored.reads).toHaveLength(GOOD.length)
    expect([...raw.puts.values()].join('')).not.toContain('or-test')

    const days = await db.select().from(schema.probeDays)
    const day = (lab: string) => days.find((d) => d.lab === lab)!
    expect(day('openai')).toMatchObject({
      day: '2026-11-20',
      placement: 'enam',
      probes: 1,
      ok: 1,
      peak_n: 1,
    })
    expect(day('anthropic')).toMatchObject({ probes: 0, excluded: 1 })
    expect(day('xai')).toMatchObject({ probes: 1, ok: 0, rate_limited: 1 })
  })

  it('keeps the row when the trace cannot be stored', async () => {
    const clock = fakeClock()
    await runProbes(db, {
      fetch: async () => streamResponse(GOOD, clock),
      clock: clock.clock,
      now: () => NOW,
      apiKey: 'or-test',
      raw: {
        put: async () => {
          throw new Error('R2 is down')
        },
      },
      readRaw: noRaw,
      ranFrom: 'local',
      placement: 'unpinned',
      targets: [TARGET],
    })
    const [row] = await db.select().from(schema.latencyProbes)
    expect(row).toMatchObject({ outcome: 'ok', raw_key: null })
  })

  it('probes the class map’s flagship as re-mapped by a decision, and stores the new model', async () => {
    // The judge re-maps OpenAI's flagship to a family the catalog serves under one id.
    await db.insert(schema.classMapDecisions).values({
      id: 'd1',
      provider: 'openai',
      class: 'flagship',
      model_slug: 'gpt-6.2-sol',
      basis: 'a sentence',
      basis_source_id: 'openai-models-md',
      decided_at: '2026-11-20T12:00:00.000Z',
      decided_by: 'judge',
      source_url: 'https://developers.openai.com/api/docs/models.md',
      fetched_at: '2026-11-20T12:00:00.000Z',
    })
    const clock = fakeClock()
    const report = await runProbes(db, {
      fetch: async () => streamResponse(GOOD, clock),
      clock: clock.clock,
      now: () => NOW,
      apiKey: 'or-test',
      raw: fakeRaw().store,
      readRaw: await seedCatalog(),
      ranFrom: 'local',
      placement: 'unpinned',
    })
    expect(report.probes.find((p) => p.lab === 'openai')!.model).toBe('openai/gpt-6.2-sol')
    const rows = await db.select().from(schema.latencyProbes)
    expect(rows.find((r) => r.lab === 'openai')!.model).toBe('openai/gpt-6.2-sol')
  })

  it('probes no lab whose flagship the catalog does not list, and spools which and why', async () => {
    await db.insert(schema.classMapDecisions).values({
      id: 'd2',
      provider: 'anthropic',
      class: 'flagship',
      model_slug: 'claude-opus-6',
      basis: 'a sentence',
      basis_source_id: 'anthropic-models-md',
      decided_at: '2026-11-20T12:00:00.000Z',
      decided_by: 'judge',
      source_url: 'https://platform.claude.com/docs/en/about-claude/models/overview.md',
      fetched_at: '2026-11-20T12:00:00.000Z',
    })
    const clock = fakeClock()
    const models: string[] = []
    const report = await runProbes(db, {
      fetch: async (_url, init) => {
        models.push(JSON.parse(init.body as string).model)
        return streamResponse(GOOD, clock)
      },
      clock: clock.clock,
      now: () => NOW,
      apiKey: 'or-test',
      raw: fakeRaw().store,
      readRaw: await seedCatalog(),
      ranFrom: 'local',
      placement: 'unpinned',
    })
    // Never the old id, and nothing else in the family.
    expect(models.filter((m) => m.startsWith('anthropic/'))).toEqual([])
    expect(models).toHaveLength(PROBE_TARGETS.length - 1)
    expect(report.unprobed.map((u) => [u.lab, u.kind])).toEqual([
      ['anthropic', PROBE_MODEL_UNRESOLVED_KIND],
    ])
    const events = await db.select().from(schema.opsEvents)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: PROBE_MODEL_UNRESOLVED_KIND })
    expect(events[0]!.detail).toContain('anthropic')
    expect(events[0]!.detail).toContain('claude-opus-6')
  })

  it('probes no flagship target when no catalog is stored, and spools each lab', async () => {
    const report = await runProbes(db, {
      fetch: async () => {
        throw new Error('must not be called')
      },
      clock: () => 0,
      now: () => NOW,
      apiKey: 'or-test',
      raw: fakeRaw().store,
      readRaw: noRaw,
      ranFrom: 'local',
      placement: 'unpinned',
    })
    expect(report.probes).toEqual([])
    const events = await db.select().from(schema.opsEvents)
    expect(events.map((e) => e.kind)).toEqual(PROBE_TARGETS.map(() => PROBE_MODEL_UNRESOLVED_KIND))
    expect(events[0]!.detail).toContain('no readable OpenRouter catalog')
  })
})

describe('probeOrigin', () => {
  it('reads the colo from Cloudflare’s trace, and says unknown when it cannot', async () => {
    expect(await probeOrigin(async () => new Response('fl=1\ncolo=EWR\nhttp=http/2\n'))).toBe(
      'cloudflare:EWR',
    )
    expect(await probeOrigin(async () => new Response('nothing'))).toBe('cloudflare:unknown')
    expect(
      await probeOrigin(async () => {
        throw new Error('offline')
      }),
    ).toBe('cloudflare:unknown')
  })
})

async function seedDay(
  day: string,
  lab: string,
  model: string,
  tps: { peak: number; off: number },
  placement: string = PRIMARY_PLACEMENT,
) {
  const market = PROBE_TARGETS.find((t) => t.lab === lab)!.market
  const window = PROBE_WINDOWS[market]
  const row = (hour: number, speed: number | null, outcome = 'ok') => {
    const started_at = `${day}T${String(hour).padStart(2, '0')}:07:00.000Z`
    return {
      id: `${lab}-${placement}-${started_at}`,
      lab,
      model,
      route: 'openrouter',
      provider: lab,
      started_at,
      outcome,
      http_status: outcome === 'ok' ? 200 : 429,
      ttft_ms: speed === null ? null : 500,
      total_ms: 2000,
      output_tokens: speed === null ? null : 160,
      tokens_per_second: speed,
      ran_from: placement === 'unpinned' ? 'cloudflare:LHR' : 'cloudflare:EWR',
      placement,
      source_url: PROBE_ENDPOINT,
      fetched_at: started_at,
    }
  }
  const rows = [
    ...window.peak.map((h) => row(h, tps.peak)),
    ...window.offpeak.map((h) => row(h, tps.off)),
  ]
  rows[0] = row(window.peak[0]!, null, 'rate_limited')
  for (const r of rows) await db.insert(schema.latencyProbes).values(r)
}

describe('queryProbes', () => {
  const ctx = (now: Date) => queryContext(sourcesYaml, '2026-11-22T00:00:00.000Z', () => now)

  it('lists every tracked lab before any probe has run, each waiting or a stated gap', async () => {
    const data = await queryProbes(db, ctx(NOW))
    expect(data.labs.map((l) => l.lab)).toEqual([...PROVIDER_ORDER])
    expect(data.since).toBeNull()
    expect(data.placement).toEqual({ hint: 'enam', label: 'eastern North America', since: null })
    for (const lab of data.labs) {
      expect(lab.latest).toBeNull()
      expect(lab.days).toEqual([])
      expect(lab.gap).toBeTruthy()
    }
    expect(data.labs.find((l) => l.lab === 'deepseek')).toMatchObject({
      status: 'not_probed',
      model: 'deepseek/deepseek-v4-pro',
    })
    expect(data.labs.find((l) => l.lab === 'mistral')).toMatchObject({
      status: 'not_probed',
      model: 'mistralai/mistral-large-4-0',
      gap: expect.stringContaining('whole output cap on reasoning'),
    })
    expect(await probesStamp(db)).toBe('none')
  })

  it('serves each day’s reading, a window over the complete days, and the newest probe', async () => {
    await seedDay('2026-11-20', 'openai', TARGET.model, { peak: 60, off: 100 })
    await seedDay('2026-11-21', 'openai', TARGET.model, { peak: 80, off: 100 })
    await seedDay('2026-11-22', 'openai', TARGET.model, { peak: 90, off: 100 })
    const now = new Date('2026-11-22T23:30:00.000Z')
    expect(await rollProbeDays(db, ['2026-11-20', '2026-11-21', '2026-11-22'], now)).toBe(3)
    // Rolling a day again rewrites its row, never adds one.
    expect(await rollProbeDays(db, ['2026-11-22'], now)).toBe(1)
    expect(await db.select().from(schema.probeDays)).toHaveLength(3)

    const data = await queryProbes(db, ctx(now))
    expect(data).toMatchObject({ since: '2026-11-20', window_days: 7, history_days: 90 })
    expect(data.probe).toMatchObject({ endpoint: PROBE_ENDPOINT, max_tokens: PROBE_MAX_TOKENS })
    const openai = data.labs.find((l) => l.lab === 'openai')!
    expect(openai.status).toBe('probed')
    expect(openai.gap).toBeNull()
    expect(openai.days.map((d) => [d.day, d.complete, d.peak_to_offpeak])).toEqual([
      ['2026-11-22', false, 0.9],
      ['2026-11-21', true, 0.8],
      ['2026-11-20', true, 0.6],
    ])
    expect(openai.days[1]).toMatchObject({
      probes: 12,
      ok: 11,
      rate_limited: 1,
      failed: 0,
      strained_share: 0.083,
      source_url: PROBE_ENDPOINT,
      fetched_at: '2026-11-21T20:07:00.000Z',
    })
    // Today is still coming in, so the window is the two complete days.
    expect(openai.window).toEqual({
      days: 2,
      probes: 24,
      rate_limited: 2,
      failed: 0,
      strained_share: 0.083,
      peak_tps: 70,
      offpeak_tps: 100,
      peak_to_offpeak: 0.7,
    })
    expect(openai.latest).toMatchObject({
      started_at: '2026-11-22T20:07:00.000Z',
      outcome: 'ok',
      tokens_per_second: 90,
      ran_from: 'cloudflare:EWR',
      placement: 'enam',
    })
    expect(openai.other_series).toEqual([])
    expect(await probesStamp(db)).toBe('2026-11-22T20:07:00.000Z')
  })

  it('keeps the unpinned probes from before placement out of the pinned series, and serves them apart', async () => {
    // The changeover day has both: unpinned hours, then pinned ones.
    await seedDay('2026-11-20', 'openai', TARGET.model, { peak: 40, off: 100 }, 'unpinned')
    await seedDay('2026-11-21', 'openai', TARGET.model, { peak: 50, off: 100 }, 'unpinned')
    await seedDay('2026-11-21', 'openai', TARGET.model, { peak: 80, off: 100 })
    await seedDay('2026-11-22', 'openai', TARGET.model, { peak: 90, off: 100 })
    const now = new Date('2026-11-23T01:00:00.000Z')
    expect(await rollProbeDays(db, ['2026-11-20', '2026-11-21', '2026-11-22'], now)).toBe(4)
    const rolled = await db.select().from(schema.probeDays)
    expect(rolled.map((d) => [d.day, d.placement, d.probes]).sort()).toEqual([
      ['2026-11-20', 'unpinned', 12],
      ['2026-11-21', 'enam', 12],
      ['2026-11-21', 'unpinned', 12],
      ['2026-11-22', 'enam', 12],
    ])

    const data = await queryProbes(db, ctx(now))
    expect(data.since).toBe('2026-11-20')
    expect(data.placement.since).toBe('2026-11-21')
    const openai = data.labs.find((l) => l.lab === 'openai')!
    expect(openai.days.map((d) => [d.day, d.placement, d.peak_to_offpeak])).toEqual([
      ['2026-11-22', 'enam', 0.9],
      ['2026-11-21', 'enam', 0.8],
    ])
    expect(openai.window).toMatchObject({ days: 2, peak_tps: 85, peak_to_offpeak: 0.85 })
    expect(openai.other_series).toHaveLength(1)
    expect(openai.other_series[0]).toMatchObject({
      placement: 'unpinned',
      pinned: false,
      window: { days: 2, peak_tps: 45 },
    })
    expect(openai.other_series[0]!.days.map((d) => [d.day, d.peak_to_offpeak])).toEqual([
      ['2026-11-21', 0.5],
      ['2026-11-20', 0.4],
    ])
  })
})

// ---- placement ---------------------------------------------------------------

/** A Durable Object namespace that records how each object was asked for. */
function fakeNamespace(answer: (placement: string) => Response | Promise<Response>) {
  const calls: { name: string; locationHint: string; url: string; method: string }[] = []
  const namespace: ProbeNamespace = {
    idFromName: (name) => ({ name }),
    get: (id, options) => ({
      fetch: async (request) => {
        const name = (id as unknown as { name: string }).name
        calls.push({
          name,
          locationHint: options.locationHint,
          url: request.url,
          method: request.method,
        })
        return answer(new URL(request.url).searchParams.get('placement')!)
      },
    }),
  }
  return { namespace, calls }
}

describe('probe placement', () => {
  it('runs from eastern North America only, until the owner adds a placement', () => {
    expect(PROBE_PLACEMENTS).toEqual(['enam'])
    expect(PRIMARY_PLACEMENT).toBe('enam')
  })

  it('has its Durable Object binding in wrangler.toml, so the cron has somewhere to send the probes', () => {
    const namespace = (env as unknown as Record<string, unknown>)[PROBE_BINDING] as
      | ProbeNamespace
      | undefined
    expect(typeof namespace?.idFromName).toBe('function')
    expect(typeof namespace?.get).toBe('function')
  })

  it('asks each placement’s own object to probe, created with that placement’s location hint', async () => {
    const { namespace, calls } = fakeNamespace((placement) =>
      Response.json({ placement, probes: [], unprobed: [], days_rolled: 0 }),
    )
    const result = await dispatchPinnedProbes(db, { PROBES: namespace }, ['enam', 'weur'])
    expect(calls).toEqual([
      {
        name: probeObjectName('enam'),
        locationHint: 'enam',
        url: `https://probes.internal${PROBE_RUN_PATH}?placement=enam`,
        method: 'POST',
      },
      {
        name: probeObjectName('weur'),
        locationHint: 'weur',
        url: `https://probes.internal${PROBE_RUN_PATH}?placement=weur`,
        method: 'POST',
      },
    ])
    expect(result.runs.map((r) => [r.placement, r.report?.placement, r.error])).toEqual([
      ['enam', 'enam', null],
      ['weur', 'weur', null],
    ])
    expect(await db.select().from(schema.opsEvents)).toEqual([])
  })

  it('probes nothing without the Durable Object binding, rather than run unpinned, and spools why', async () => {
    for (const env of [undefined, {}, { PROBES: 'not a namespace' }]) {
      const result = await dispatchPinnedProbes(db, env)
      expect(result.runs).toEqual([])
      expect(result.skipped).toContain('PROBES')
    }
    const events = await db.select().from(schema.opsEvents)
    expect(events.map((e) => e.kind)).toEqual([
      PROBE_UNPINNED_KIND,
      PROBE_UNPINNED_KIND,
      PROBE_UNPINNED_KIND,
    ])
    expect(await db.select().from(schema.latencyProbes)).toEqual([])
  })

  it('spools a placement whose object fails, and keeps the others', async () => {
    const { namespace } = fakeNamespace((placement) =>
      placement === 'weur'
        ? new Response('boom', { status: 500 })
        : Response.json({ placement, probes: [], unprobed: [], days_rolled: 0 }),
    )
    const result = await dispatchPinnedProbes(db, { PROBES: namespace }, ['enam', 'weur'])
    expect(result.runs.map((r) => [r.placement, r.error])).toEqual([
      ['enam', null],
      ['weur', 'HTTP 500: boom'],
    ])
    const [event] = await db.select().from(schema.opsEvents)
    expect(event).toMatchObject({
      kind: PROBE_PLACEMENT_FAILED_KIND,
      detail: 'weur: HTTP 500: boom',
    })
  })

  it('runs the probe route only inside a Durable Object', () => {
    expect(insideDurableObject({})).toBe(false)
    expect(insideDurableObject({ cloudflare: { env: {}, request: {} } })).toBe(false)
    expect(insideDurableObject({ cloudflare: { env: {}, durable: {} } })).toBe(true)
  })

  it('reads the router’s name for the provider against the pinned slug', () => {
    expect(servedByPinned('Google AI Studio', 'google-ai-studio')).toBe(true)
    expect(servedByPinned('Moonshot AI', 'moonshotai')).toBe(true)
    expect(servedByPinned('xAI', 'xai')).toBe(true)
    expect(servedByPinned('Together', 'meta')).toBe(false)
    expect(servedByPinned(null, 'openai')).toBeNull()
  })

  it('keeps only rate-limit headers, and never a cookie', () => {
    const headers = responseHeaders(
      new Headers({
        'X-RateLimit-Limit-Requests': '5000',
        'ratelimit-reset': '12',
        'Retry-After': '3',
        'set-cookie': 'a=b',
        'content-type': 'text/event-stream',
      }),
    )
    expect(headers).not.toHaveProperty('set-cookie')
    expect(JSON.parse(rateLimitHeaders(headers)!)).toEqual({
      'ratelimit-reset': '12',
      'retry-after': '3',
      'x-ratelimit-limit-requests': '5000',
    })
    expect(rateLimitHeaders({ 'content-type': 'text/event-stream' })).toBeNull()
  })
})

// ---- the fixed workload ------------------------------------------------------

describe('the probe targets', () => {
  it('cover every tracked lab once, as a target or a stated gap', () => {
    const labs = [...PROBE_TARGETS.map((t) => t.lab), ...PROBE_GAPS.map((g) => g.lab)]
    expect([...labs].sort()).toEqual([...PROVIDER_ORDER].sort())
  })

  it('pin each request to one provider with fallbacks off', () => {
    for (const target of RESOLVED_TARGETS) {
      const body = probeRequestBody(target)
      expect(body.provider).toEqual({ only: [target.provider], allow_fallbacks: false })
      expect(body.stream).toBe(true)
      expect(body.max_tokens).toBe(PROBE_MAX_TOKENS + (target.reasoning_allowance ?? 0))
    }
  })

  it('leave room for an answer where the endpoint counts reasoning against the cap', () => {
    const body = (lab: string) => probeRequestBody(RESOLVED_TARGETS.find((t) => t.lab === lab)!)
    expect(body('meta').max_tokens).toBe(480)
    expect(body('openai').max_tokens).toBe(160)
  })

  it('stay inside the monthly budget at the 2026-11-20 catalog prices, counting what xAI bills outside the cap', () => {
    expect(PROBE_MONTHLY_BUDGET_USD).toBe(24)
    expect(RESOLVED.skipped).toEqual([])
    expect(RESOLVED_TARGETS).toHaveLength(PROBE_TARGETS.length)
    const ceiling = monthlyCostCeiling(RESOLVED_TARGETS)
    expect(ceiling).toBeGreaterThan(20)
    expect(ceiling).toBeLessThan(PROBE_MONTHLY_BUDGET_USD)
    const only = (lab: string) => monthlyCostCeiling(RESOLVED_TARGETS.filter((t) => t.lab === lab))
    // 40 + 1,260 prompt tokens at $2 and 160 + 700 output tokens at $6, 732 times.
    expect(only('xai')).toBeCloseTo(5.68, 2)
  })
})

// ---- choosing the model ------------------------------------------------------

/** A catalog row with prices in USD per million tokens. */
const row = (id: string, input: number | null = 1, output: number | null = 5) => ({
  ...CATALOG.rows[0]!,
  or_model_id: id,
  provider: CATALOG.rows.find((r) => r.or_model_id.startsWith(`${id.split('/')[0]}/`))!.provider,
  prompt_per_tok: input === null ? null : input / 1e6,
  completion_per_tok: output === null ? null : output / 1e6,
})
const withRows = (...rows: ReturnType<typeof row>[]): ProbeCatalog => ({
  ...CATALOG,
  rows: [...CATALOG.rows, ...rows],
})
const flagshipOf = (lab: string) =>
  MODEL_CLASS_MAP.find((e) => e.provider === lab && e.class === 'flagship')!.model_slug
const match = (lab: string, family: string, catalog: ProbeCatalog = CATALOG) =>
  matchFlagship(lab, family, catalog.rows)?.or_model_id ?? null

describe('the flagship match', () => {
  it('reads a slug as words and version numbers', () => {
    expect(slugTokens('gpt-6.2-astra')).toEqual([
      { word: 'gpt' },
      { version: [6, 2] },
      { word: 'astra' },
    ])
    expect(slugTokens('claude-opus-5-5')).toEqual([
      { word: 'claude' },
      { word: 'opus' },
      { version: [5, 5] },
    ])
    expect(slugTokens('qwen4-max')).toEqual([{ word: 'qwen' }, { version: [4] }, { word: 'max' }])
  })

  it('picks each probed lab’s flagship from the 2026-11-20 catalog', () => {
    expect(RESOLVED_TARGETS.map((t) => [t.lab, t.model])).toEqual([
      ['openai', 'openai/gpt-6.2-astra'],
      ['anthropic', 'anthropic/claude-opus-5.5'],
      ['google', 'google/gemini-4-carbon'],
      ['xai', 'x-ai/grok-4.7'],
      ['meta', 'meta/muse-wonder'],
      ['alibaba', 'qwen/qwen4-max'],
      ['moonshot', 'moonshotai/kimi-k3.1-pro'],
    ])
  })

  it('reads the price from the catalog row, per million tokens', () => {
    const price = (lab: string) => RESOLVED_TARGETS.find((t) => t.lab === lab)!.list_price
    expect(price('openai')).toEqual({ input: 8, output: 40 })
    expect(price('alibaba')).toEqual({ input: 1.425, output: 4.275 })
    // Moonshot's output price on OpenRouter was $10 when the target was pinned.
    expect(price('moonshot')).toEqual({ input: 0.253, output: 8.8 })
  })

  it('takes the newest point release of a family, over the family’s own first id', () => {
    // The catalog lists both openai/gpt-6-astra and openai/gpt-6.2-astra.
    expect(CATALOG.rows.some((r) => r.or_model_id === 'openai/gpt-6-astra')).toBe(true)
    expect(match('openai', 'gpt-6-astra')).toBe('openai/gpt-6.2-astra')
    expect(match('openai', 'gpt-6-astra', withRows(row('openai/gpt-6.3-astra')))).toBe(
      'openai/gpt-6.3-astra',
    )
    // Numbers, not strings: 6.10 is newer than 6.9.
    expect(
      match(
        'openai',
        'gpt-6-astra',
        withRows(row('openai/gpt-6.9-astra'), row('openai/gpt-6.10-astra')),
      ),
    ).toBe('openai/gpt-6.10-astra')
  })

  it('never takes another word, another family, a variant endpoint or another lab’s id', () => {
    const catalog = withRows(
      row('openai/gpt-7-astra'),
      row('openai/gpt-6.4-astra-pro'),
      row('openai/gpt-6.4-astra:free'),
      row('meta-llama/gpt-6.4-astra'),
    )
    expect(match('openai', 'gpt-6-astra', catalog)).toBe('openai/gpt-6.2-astra')
    // claude-opus-5 and claude-opus-5-fast are listed; neither is Opus 5.5.
    expect(match('anthropic', 'claude-opus-5-5')).toBe('anthropic/claude-opus-5.5')
    expect(match('anthropic', 'claude-opus-5-5', withRows(row('anthropic/claude-opus-5.6')))).toBe(
      'anthropic/claude-opus-5.5',
    )
    expect(match('xai', 'grok-4.7')).toBe('x-ai/grok-4.7')
  })

  it('takes an unversioned id for a first release only, when no id in the family carries a version', () => {
    expect(flagshipOf('meta')).toBe('muse-wonder-1.0')
    expect(match('meta', 'muse-wonder-1.0')).toBe('meta/muse-wonder')
    expect(match('meta', 'muse-wonder-1.0', withRows(row('meta/muse-wonder-1.0')))).toBe(
      'meta/muse-wonder-1.0',
    )
    // Another word is still another model.
    expect(match('meta', 'muse-spark-1.3')).toBe('meta/muse-spark-1.3')
    // A later release is not the unversioned id, which may be the first one.
    expect(match('meta', 'muse-wonder-1.1')).toBeNull()
    expect(match('meta', 'muse-wonder-2')).toBeNull()
  })

  it('matches nothing when the catalog does not list the family', () => {
    expect(match('openai', 'gpt-9-astra')).toBeNull()
    // The catalog lists mistralai/mistral-large, an unversioned name: not Large 5.
    expect(CATALOG.rows.some((r) => r.or_model_id === 'mistralai/mistral-large')).toBe(true)
    expect(match('mistral', 'mistral-large-5')).toBeNull()
  })
})

describe('resolveProbeTargets', () => {
  const remap = (lab: string, model_slug: string) =>
    MODEL_CLASS_MAP.map((e) =>
      e.provider === lab && e.class === 'flagship' ? { ...e, model_slug } : e,
    )

  it('skips a lab whose flagship has no catalog row, never falling back to an earlier id', () => {
    const { targets, skipped } = resolveProbeTargets(
      PROBE_TARGETS,
      remap('openai', 'gpt-9-astra'),
      CATALOG,
    )
    expect(targets.map((t) => t.lab)).not.toContain('openai')
    expect(targets).toHaveLength(PROBE_TARGETS.length - 1)
    expect(skipped).toEqual([
      {
        lab: 'openai',
        kind: PROBE_MODEL_UNRESOLVED_KIND,
        detail: expect.stringContaining('flagship gpt-9-astra'),
      },
    ])
  })

  it('skips a match with no fixed price', () => {
    const catalog: ProbeCatalog = {
      ...CATALOG,
      rows: CATALOG.rows.map((r) =>
        r.or_model_id === 'x-ai/grok-4.7' ? { ...r, completion_per_tok: null } : r,
      ),
    }
    const { targets, skipped } = resolveProbeTargets(PROBE_TARGETS, MODEL_CLASS_MAP, catalog)
    expect(targets.map((t) => t.lab)).not.toContain('xai')
    expect(skipped).toMatchObject([{ lab: 'xai', kind: PROBE_MODEL_UNRESOLVED_KIND }])
    expect(skipped[0]!.detail).toContain('no fixed price')
  })

  it('skips a flagship whose price would take the month over budget, and keeps the rest', () => {
    // A new Opus point release at ten times the price.
    const catalog = withRows(row('anthropic/claude-opus-5.5.1', 40, 200))
    const { targets, skipped } = resolveProbeTargets(
      PROBE_TARGETS,
      remap('anthropic', 'claude-opus-5-5'),
      catalog,
    )
    expect(targets.map((t) => t.lab)).toEqual(
      PROBE_TARGETS.map((t) => t.lab).filter((lab) => lab !== 'anthropic'),
    )
    expect(skipped).toEqual([
      {
        lab: 'anthropic',
        kind: PROBE_OVER_BUDGET_KIND,
        detail: expect.stringMatching(
          /claude-opus-5\.5\.1 at \$40 in \/ \$200 out .* over the \$24\.00 budget/,
        ),
      },
    ])
    expect(monthlyCostCeiling(targets)).toBeLessThanOrEqual(PROBE_MONTHLY_BUDGET_USD)
  })

  it('probes a pinned target as written, whatever the catalog says', () => {
    const pinned: PinnedProbeTarget = {
      lab: 'deepseek',
      model: 'deepseek/deepseek-v4-pro',
      provider: 'deepseek',
      effort: 'none',
      note: 'The owner picked it.',
      market: 'china',
      list_price: { input: 1, output: 2 },
    }
    const { targets, skipped } = resolveProbeTargets([pinned], MODEL_CLASS_MAP, null)
    expect(skipped).toEqual([])
    expect(targets).toEqual([{ ...pinned, chosen_from: null }])
  })
})
