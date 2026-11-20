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
import { probeOrigin, probeRawKey, runProbes } from '../server/pipeline/probes/run'
import {
  classify,
  createStreamReader,
  measure,
  runProbe,
  type ProbeEnd,
  type ProbeFetch,
  type StreamState,
} from '../server/pipeline/probes/stream'
import {
  PROBE_ENDPOINT,
  PROBE_GAPS,
  PROBE_MAX_TOKENS,
  PROBE_TARGETS,
  PROBE_WINDOWS,
  monthlyCostCeiling,
  probeRequestBody,
} from '../server/pipeline/probes/targets'
import { queryContext } from '../server/utils/terminal-db'
import { probesStamp, queryProbes } from '../server/utils/terminal-probes'
import { PROVIDER_ORDER } from '../server/utils/terminal-sources'
import { fixtureText } from './pipeline/fixtures'

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')

beforeEach(async () => {
  await db.delete(schema.latencyProbes)
  await db.delete(schema.probeDays)
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

  it('counts streamed reasoning as tokens arriving, and an encrypted blob as nothing', () => {
    const hidden = read([
      [200, chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'AAAA' }] })],
      [900, chunk({ content: 'one' })],
    ])
    expect(hidden).toMatchObject({ first_token_at: 900, reasoning_streamed: false })
    const shown = read([
      [200, chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'Counting.' }] })],
      [900, chunk({ content: 'one' })],
    ])
    expect(shown).toMatchObject({ first_token_at: 200, reasoning_streamed: true })
    expect(read([[150, chunk({ reasoning: 'Counting.' })]]).first_token_at).toBe(150)
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
    { status: 200, headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-h' } },
  )
}

const TARGET = PROBE_TARGETS[0]!
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
    })
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
      ranFrom: 'local',
    })
    expect(report).toEqual({ skipped: OPENROUTER_KEY_UNSET, probes: [], days_rolled: 0 })
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
      ranFrom: 'cloudflare:EWR',
    })
    expect(widest).toBe(1)
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
      source_url: PROBE_ENDPOINT,
      fetched_at: NOW.toISOString(),
      raw_key: probeRawKey('openai', NOW.toISOString()),
    })
    const stored = JSON.parse(raw.puts.get(openai.raw_key!)!)
    expect(stored.request.provider).toEqual({ only: ['openai'], allow_fallbacks: false })
    expect(stored.reads).toHaveLength(GOOD.length)
    expect([...raw.puts.values()].join('')).not.toContain('or-test')

    const days = await db.select().from(schema.probeDays)
    const day = (lab: string) => days.find((d) => d.lab === lab)!
    expect(day('openai')).toMatchObject({ day: '2026-11-20', probes: 1, ok: 1, peak_n: 1 })
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
      ranFrom: 'local',
      targets: [TARGET],
    })
    const [row] = await db.select().from(schema.latencyProbes)
    expect(row).toMatchObject({ outcome: 'ok', raw_key: null })
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
) {
  const market = PROBE_TARGETS.find((t) => t.lab === lab)!.market
  const window = PROBE_WINDOWS[market]
  const row = (hour: number, speed: number | null, outcome = 'ok') => {
    const started_at = `${day}T${String(hour).padStart(2, '0')}:07:00.000Z`
    return {
      id: `${lab}-${started_at}`,
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
      ran_from: 'cloudflare:EWR',
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
      status: 'waiting',
      model_note: expect.stringContaining('name no flagship'),
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
    })
    expect(await probesStamp(db)).toBe('2026-11-22T20:07:00.000Z')
  })
})

// ---- the fixed workload ------------------------------------------------------

describe('the probe targets', () => {
  it('cover every tracked lab once, as a target or a stated gap', () => {
    const labs = [...PROBE_TARGETS.map((t) => t.lab), ...PROBE_GAPS.map((g) => g.lab)]
    expect([...labs].sort()).toEqual([...PROVIDER_ORDER].sort())
  })

  it('pin each request to one provider with fallbacks off', () => {
    for (const target of PROBE_TARGETS) {
      const body = probeRequestBody(target)
      expect(body.provider).toEqual({ only: [target.provider], allow_fallbacks: false })
      expect(body.stream).toBe(true)
      expect(body.max_tokens).toBe(PROBE_MAX_TOKENS)
    }
  })

  it('stay inside the owner’s budget of $15 a month at list prices', () => {
    const ceiling = monthlyCostCeiling()
    expect(ceiling).toBeGreaterThan(10)
    expect(ceiling).toBeLessThan(15)
  })
})
