import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import type { SourceFetcher } from '../server/pipeline/fetch'
import { runRefresh, type RawStore } from '../server/pipeline/refresh'
import { includeSources } from '../server/pipeline/sources'
import { ALERT_SEARCH_DEPTH, createTerminalMcpHandler, type McpDeps } from '../server/utils/mcp'
import { terminalStamp } from '../server/utils/terminal-cache'
import { queryContext } from '../server/utils/terminal-db'
import { fixtureText, manifest } from './pipeline/fixtures'

// The MCP endpoint over HTTP, as a client speaks it: a legacy (2025-era)
// `initialize`, then tools/list and tools/call, each a stateless POST with
// a JSON response. The store is seeded the way production is — the
// committed fixtures pushed through runRefresh — so every tool result
// carries live provenance, and one scenario fires the S-1 floor rule so
// there is an alert to fetch by id.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const ALL_IDS = includeSources(sourcesYaml, manifest.fixtures).map((s) => s.source_id)

const SPCX_CIK = '0001181412'
const ftsWithNewS1 = () => {
  const doc = JSON.parse(fixtureText('fixtures/sec/edgar-fts.json')) as {
    hits: { hits: unknown[] }
  }
  const hit = {
    _source: {
      adsh: '0001628280-26-099999',
      form: 'S-1/A',
      file_date: '2026-09-01',
      ciks: [SPCX_CIK],
      display_names: ['SPACE EXPLORATION TECHNOLOGIES CORP  (SPCX)  (CIK 0001181412)'],
    },
  }
  return JSON.stringify({ ...doc, hits: { ...doc.hits, hits: [hit, ...doc.hits.hits] } })
}

function fixtureFetcher(overrides: Record<string, string> = {}): SourceFetcher {
  const byUrl = new Map(manifest.fixtures.map((f) => [f.source_url, fixtureText(f.path)]))
  return async (source) => {
    const text = overrides[source.source_id] ?? byUrl.get(source.url)
    if (text === undefined) throw new Error(`no fixture for ${source.url}`)
    return { ok: true, status: 200, text, bytes: text.length }
  }
}

const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}

let tick = Date.parse('2026-09-07T10:00:00Z')
const now = () => new Date((tick += 1000))
const FIXED_NOW = () => new Date('2026-09-07T12:00:00Z')

const LLMS = '# Frontier Terminal\n\n> A fixture llms.txt.\n'

const deps: McpDeps = {
  db,
  serve: async (_name, query) =>
    query(queryContext(sourcesYaml, await terminalStamp(db), FIXED_NOW)),
  llmsTxt: LLMS,
  appUrl: 'https://example.com',
  status: {
    buildSha: 'abc123',
    buildDate: '2026-09-07',
    scheduledTasks: { '0 */6 * * *': ['poll:survey'] },
  },
}

const handler = createTerminalMcpHandler(deps)

const LEGACY_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-06-18',
}

let nextId = 1
function rpc(method: string, params: Record<string, unknown> = {}): Request {
  return new Request('https://example.com/mcp', {
    method: 'POST',
    headers: LEGACY_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })
}

interface RpcResponse {
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

async function call(method: string, params: Record<string, unknown> = {}): Promise<RpcResponse> {
  const response = await handler(rpc(method, params))
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/json')
  return (await response.json()) as RpcResponse
}

interface ToolResult {
  content: { type: string; text?: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const { result, error } = await call('tools/call', { name, arguments: args })
  expect(error).toBeUndefined()
  return result as unknown as ToolResult
}

beforeAll(async () => {
  const run = (ids: readonly string[], fetcher: SourceFetcher) =>
    runRefresh({ db, raw, fetcher, sourcesYaml, now }, 'survey', ids)
  await run(ALL_IDS, fixtureFetcher())
  // A new S-1/A on EDGAR trips the deterministic floor rule: one alert.
  await run(['edgar-fts'], fixtureFetcher({ 'edgar-fts': ftsWithNewS1() }))
})

describe('the transport', () => {
  it('answers initialize with the server identity and its capabilities, as JSON', async () => {
    const { result } = await call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    expect(result).toMatchObject({
      protocolVersion: expect.any(String),
      serverInfo: { name: 'frontier-terminal' },
      capabilities: { tools: expect.any(Object), resources: expect.any(Object) },
    })
    expect(String(result!.instructions)).toContain('Not investment advice')
  })

  it('is stateless: GET (the SSE stream) and DELETE (session end) are 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await handler(
        new Request('https://example.com/mcp', { method, headers: LEGACY_HEADERS }),
      )
      expect(response.status).toBe(405)
    }
  })

  it('refuses an unknown method in-band, not with an HTTP error', async () => {
    const { error } = await call('tools/nope')
    expect(error).toMatchObject({ code: -32601 })
  })
})

describe('tools/list', () => {
  it('lists every tool, all read-only, each with documentation an analyst’s agent can act on', async () => {
    const { result } = await call('tools/list')
    const tools = result!.tools as { name: string; description: string; annotations: unknown }[]
    expect(tools.map((t) => t.name).sort()).toEqual([
      'describe',
      'get_alert',
      'get_alerts',
      'get_coverage',
      'get_hiring',
      'get_hiring_history',
      'get_incidents',
      'get_overview',
      'get_price_history',
      'get_prices',
      'get_rankings',
      'get_releases',
      'get_status',
    ])
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true })
      expect(t.description.length).toBeGreaterThan(80)
    }
    const hiring = tools.find((t) => t.name === 'get_hiring')!
    expect(hiring.description).toContain('SpaceX')
    expect(hiring.description).toContain('no public')
    expect(tools.find((t) => t.name === 'get_prices')!.description).toContain('OpenRouter')
    // The number's limits travel with the tool, in the audit's terms.
    expect(tools.find((t) => t.name === 'get_rankings')!.description).toContain('NOT market share')
    expect(tools.find((t) => t.name === 'get_rankings')!.description).toContain('CC BY 4.0')
    expect(tools.find((t) => t.name === 'get_incidents')!.description).toContain(
      'xAI has NO public feed',
    )
    expect(tools.find((t) => t.name === 'get_hiring_history')!.description).toContain(
      'RECONSTRUCTED',
    )
    expect(tools.find((t) => t.name === 'get_releases')!.description).toContain('EXCLUDED')
  })

  it('serves llms.txt as a resource and as the describe tool', async () => {
    const list = await call('resources/list')
    const resources = list.result!.resources as { uri: string }[]
    expect(resources.map((r) => r.uri)).toEqual(['https://example.com/llms.txt'])

    const read = await call('resources/read', { uri: 'https://example.com/llms.txt' })
    const contents = read.result!.contents as { text: string; mimeType: string }[]
    expect(contents[0]).toMatchObject({ text: LLMS, mimeType: 'text/markdown' })

    const described = await tool('describe')
    expect(described.content[0]!.text).toBe(LLMS)
  })
})

describe('tools/call', () => {
  it('get_overview: the signal band, with provenance on every cited row', async () => {
    const { content, structuredContent } = await tool('get_overview')
    // The text block is the same payload, for clients that ignore structuredContent.
    expect(JSON.parse(content[0]!.text!)).toEqual(structuredContent)
    const overview = structuredContent as {
      as_of: string
      movement: { recent: { sec: number }; window_hours: number }
      alerts: { source_url: string; fetched_at: string; changes: { source_url: string }[] }[]
      alert_count: number
      ticker_count: number
    }
    expect(overview.as_of).toMatch(/^2026-09-07T10:/)
    expect(overview.movement.window_hours).toBe(24)
    expect(overview.movement.recent.sec).toBe(1)
    expect(overview.alert_count).toBe(1)
    expect(overview.ticker_count).toBe(0)
    const [alert] = overview.alerts
    expect(alert!.source_url).toMatch(/^https:\/\//)
    expect(alert!.fetched_at).toMatch(/^2026-/)
    expect(alert!.changes[0]!.source_url).toMatch(/^https:\/\/efts\.sec\.gov\//)
  })

  it('get_prices: the catalog and the matrix, narrowed by provider without losing provenance', async () => {
    const all = (await tool('get_prices')).structuredContent as {
      rows: { provider: string; source_url: string; fetched_at: string }[]
      matrix: { providers: string[]; cells: { provider: string }[] }
      counts: { total: number }
      cross_check: { source_id: string } | null
    }
    expect(all.matrix.providers).toEqual(['openai', 'anthropic', 'google', 'xai'])
    expect(all.cross_check?.source_id).toBe('openrouter-models')
    for (const row of all.rows) {
      expect(row.source_url).toMatch(/^https:\/\//)
      expect(row.fetched_at).toMatch(/^2026-/)
    }

    const xai = (await tool('get_prices', { provider: 'xai' })).structuredContent as typeof all
    expect(xai.rows.length).toBeGreaterThan(0)
    expect(xai.rows.every((r) => r.provider === 'xai')).toBe(true)
    expect(xai.matrix.providers).toEqual(['xai'])
    expect(xai.matrix.cells.every((c) => c.provider === 'xai')).toBe(true)
    expect(xai.counts.total).toBe(xai.rows.length)
    expect(xai.counts.total).toBeLessThan(all.counts.total)
  })

  it('get_hiring: counts from the current set, and Google is an honest cut', async () => {
    const google = (await tool('get_hiring', { provider: 'google' })).structuredContent as {
      providers: { provider: string; feed: string; total: number; reason: string | null }[]
    }
    expect(google.providers).toHaveLength(1)
    expect(google.providers[0]).toMatchObject({
      provider: 'google',
      feed: 'no_public_feed',
      total: 0,
    })
    expect(google.providers[0]!.reason).toBeTruthy()

    const xai = (await tool('get_hiring', { provider: 'xai' })).structuredContent as {
      providers: { total: number; caveat: string | null; company_names: string[] }[]
    }
    expect(xai.providers[0]!.total).toBe(42)
    expect(xai.providers[0]!.caveat).toContain('SpaceXAI')
  })

  it('get_alerts and get_alert: the same alert by list, by tier, by severity, and by id', async () => {
    const listed = (await tool('get_alerts', { limit: 5 })).structuredContent as {
      tier: string
      rows: { id: string; severity: string; rule: string }[]
      total: number
    }
    expect(listed.tier).toBe('all')
    expect(listed.total).toBe(1)
    expect(listed.rows[0]).toMatchObject({ rule: 's1-floor', severity: 'critical' })

    const ticker = (await tool('get_alerts', { tier: 'ticker' })).structuredContent as typeof listed
    expect(ticker).toMatchObject({ tier: 'ticker', rows: [], total: 0 })

    const critical = (await tool('get_alerts', { severity: 'critical' }))
      .structuredContent as typeof listed
    expect(critical.rows.map((r) => r.id)).toEqual([listed.rows[0]!.id])
    const info = (await tool('get_alerts', { severity: 'info' })).structuredContent as typeof listed
    expect(info.rows).toEqual([])

    const one = (await tool('get_alert', { id: listed.rows[0]!.id })).structuredContent as {
      alert: { id: string; changes: { entity_key: string; fields: unknown[] }[] }
    }
    expect(one.alert.id).toBe(listed.rows[0]!.id)
    expect(one.alert.changes[0]!.entity_key).toBe('filing:0001628280-26-099999')
    expect(one.alert.changes[0]!.fields.length).toBeGreaterThan(0)

    const missing = await tool('get_alert', { id: 'nope' })
    expect(missing.isError).toBe(true)
  })

  it('get_price_history: one SKU’s series from the baseline, and an unknown key is an error', async () => {
    const key = 'model:xai:grok-4.6:standard'
    const history = (await tool('get_price_history', { key })).structuredContent as {
      entity_key: string
      provider: string
      model_slug: string
      removed: boolean
      points: {
        kind: string
        input_per_mtok: number | null
        source_url: string
        fetched_at: string
      }[]
    }
    expect(history).toMatchObject({
      entity_key: key,
      provider: 'xai',
      model_slug: 'grok-4.6',
      removed: false,
    })
    // One poll so far, nothing changed: the current row is the whole series.
    expect(history.points.map((p) => [p.kind, p.input_per_mtok])).toEqual([['current', 2]])
    expect(history.points[0]!.source_url).toBe('https://docs.x.ai/developers/models.md')
    expect(history.points[0]!.fetched_at).toMatch(/^2026-09-07T10:/)

    const missing = await tool('get_price_history', { key: 'model:xai:nope' })
    expect(missing.isError).toBe(true)
    expect(missing.content[0]!.text).toContain('get_prices')
  })

  it('get_hiring_history: the current set reconstructed per day, Google an honest cut, filterable', async () => {
    const all = (await tool('get_hiring_history')).structuredContent as {
      window_days: number
      log: { changes: number }
      providers: {
        provider: string
        feed: string
        dates: string[]
        total: number[]
        series_from: string | null
        baseline_at: string | null
        caveat: string | null
        sources: { source_url: string; fetched_at: string }[]
      }[]
    }
    expect(all.window_days).toBe(30)
    expect(all.log.changes).toBe(0)
    expect(all.providers.map((p) => p.provider)).toEqual(['openai', 'anthropic', 'google', 'xai'])
    const google = all.providers[2]!
    expect(google).toMatchObject({ feed: 'no_public_feed', dates: [], total: [] })

    const xai = (await tool('get_hiring_history', { provider: 'xai' }))
      .structuredContent as typeof all
    expect(xai.providers).toHaveLength(1)
    expect(xai.providers[0]).toMatchObject({
      provider: 'xai',
      feed: 'ok',
      dates: ['2026-09-07'],
      total: [42],
    })
    expect(xai.providers[0]!.series_from).toMatch(/^2026-09-07T10:/)
    expect(xai.providers[0]!.baseline_at).toMatch(/^2026-09-07T10:/)
    expect(xai.providers[0]!.caveat).toContain('SpaceXAI')
    expect(xai.providers[0]!.sources[0]!.source_url).toMatch(/^https:\/\//)
  })

  it('get_releases: a store with only baselines has no releases, and says where the log begins', async () => {
    const releases = (await tool('get_releases')).structuredContent as {
      rows: unknown[]
      excluded_baseline: number
      log_from: string | null
      total?: number
    }
    expect(releases.rows).toEqual([])
    expect(releases.excluded_baseline).toBe(0)
    expect(releases.log_from).toMatch(/^2026-09-07T10:/)
    expect(releases.total).toBeUndefined()

    const limited = (await tool('get_releases', { limit: 5 })).structuredContent as typeof releases
    expect(limited).toMatchObject({ rows: [], total: 0 })
  })

  it('get_incidents: three feeds with provenance, xAI a stated cut, filterable', async () => {
    const all = (await tool('get_incidents')).structuredContent as {
      window_to: string
      window_days: number
      providers: {
        provider: string
        feed: string
        reason: string | null
        last_window: number
        open: { incident_id: string }[]
        sources: { source_url: string; fetched_at: string }[]
      }[]
      incidents: {
        provider: string
        source_url: string
        fetched_at: string
        incident_url: string
      }[]
    }
    expect(all.window_to).toMatch(/^2026-09-07T10:/)
    expect(all.window_days).toBe(30)
    expect(all.providers.map((p) => [p.provider, p.feed])).toEqual([
      ['openai', 'ok'],
      ['anthropic', 'ok'],
      ['google', 'ok'],
      ['xai', 'no_public_feed'],
    ])
    expect(all.providers[3]!.reason).toContain('403')
    expect(all.incidents.length).toBeGreaterThan(0)
    for (const i of all.incidents) {
      expect(i.source_url).toMatch(/^https:\/\//)
      expect(i.fetched_at).toMatch(/^2026-/)
      expect(i.incident_url).toMatch(/^https:\/\//)
    }

    const openai = (await tool('get_incidents', { provider: 'openai' }))
      .structuredContent as typeof all
    expect(openai.providers.map((p) => p.provider)).toEqual(['openai'])
    expect(openai.providers[0]!.open.map((i) => i.incident_id)).toEqual([
      '01M20PYYYGRT9303VHAPA7YNT2',
    ])
    expect(openai.incidents.every((i) => i.provider === 'openai')).toBe(true)
    expect(openai.incidents.length).toBeLessThan(all.incidents.length)
  })

  it('get_rankings: OpenRouter share with the CC BY 4.0 citation and its as_of', async () => {
    const rankings = (await tool('get_rankings')).structuredContent as {
      status: string
      source: { source_id: string; license: string | null; caveat: string | null }
      provenance: { source_url: string; fetched_at: string } | null
      meta: { as_of: string | null; citation: string | null; coverage: { days: number } }
      shares: { provider: string; share: number | null }[]
    }
    expect(rankings.status).toBe('ok')
    expect(rankings.source.source_id).toBe('openrouter-rankings-daily')
    expect(rankings.source.license).toContain('CC BY 4.0')
    expect(rankings.source.caveat).toContain('not market share')
    expect(rankings.provenance!.source_url).toBe(
      'https://openrouter.ai/api/v1/datasets/rankings-daily',
    )
    expect(rankings.meta.as_of).toBe('2026-09-09T12:00:03.352Z')
    expect(rankings.meta.citation).toBe(
      'Source: OpenRouter (openrouter.ai/rankings), as of 2026-09-09T12:00:03.352Z. Licensed under CC BY 4.0.',
    )
    expect(rankings.meta.coverage.days).toBe(30)
    const total = rankings.shares.reduce((n, s) => n + (s.share ?? 0), 0)
    expect(total).toBeCloseTo(1, 6)
  })

  it('rejects arguments the schema does not allow', async () => {
    const { error, result } = await call('tools/call', {
      name: 'get_alerts',
      arguments: { limit: ALERT_SEARCH_DEPTH + 1 },
    })
    // Either an in-band JSON-RPC error or an isError result is a refusal; a
    // payload is not.
    expect(error !== undefined || (result as unknown as ToolResult).isError === true).toBe(true)
  })

  it('get_coverage: every registered source, with the audit’s caveats, and the cuts', async () => {
    const coverage = (await tool('get_coverage')).structuredContent as {
      sources: {
        source_id: string
        caveat: string | null
        newest_snapshot: { source_url: string } | null
      }[]
      cuts: { id: string }[]
      exports: { name: string }[]
    }
    expect(coverage.sources).toHaveLength(17)
    expect(coverage.sources.find((s) => s.source_id === 'openrouter-models')!.caveat).toContain(
      'never source of record',
    )
    expect(coverage.sources.every((s) => s.newest_snapshot !== null)).toBe(true)
    expect(coverage.cuts.map((c) => c.id)).toContain('google-hiring')
    expect(coverage.exports.map((e) => e.name)).toContain('alerts')
  })

  it('get_status: the same payload as /api/status', async () => {
    const status = (await tool('get_status')).structuredContent as {
      status: string
      build: { sha: string }
      migrations: { pending: string[] }
      crons: Record<string, string[]>
      sources: Record<string, string>
    }
    expect(status.status).toBe('ok')
    expect(status.build.sha).toBe('abc123')
    expect(status.migrations.pending).toEqual([])
    expect(status.crons).toEqual(deps.status.scheduledTasks)
    expect(Object.keys(status.sources)).toContain('edgar-fts')
  })
})
