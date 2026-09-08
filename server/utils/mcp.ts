// The MCP server: the terminal's read-only query layer, exposed to an agent
// over Streamable HTTP at /mcp (server/routes/mcp.ts).
//
// It lives inside the one Worker rather than beside it, and that is the
// decision worth recording. A second Worker calling the public JSON API
// would funnel every MCP user through one egress IP — and straight into the
// per-IP rate limit — and would be a second deploy to keep in step. In-process,
// every tool calls the same query function as its JSON route, reads through
// the same KV entry (terminalPayload), and is rate-limited per real client
// IP by the same rateLimit() the routes use. No auth: the site has no
// accounts, the data is public, and a credential would only be a thing to
// leak.
//
// Stateless and JSON on both protocol eras. Each request gets a fresh
// McpServer — fourteen registrations, cheap — so a Worker isolate holds no
// session, and a client that reconnects to a different isolate notices
// nothing. Legacy (2025-era) clients, which is every shipping client today,
// are served through a per-request WebStandardStreamableHTTPServerTransport
// with JSON responses; modern (2026-07-28) clients through createMcpHandler.
// The split is the composition the SDK documents on isLegacyRequest().
//
// Every payload is the JSON route's payload, verbatim: provenance
// (source_url + fetched_at) is a field of the data, so it cannot be stripped
// here without changing the type. Tool descriptions say what a number means
// and what it does not, in the audit's terms, because the reader is an
// agent that has never seen the site.
//
// ── Extension point ──────────────────────────────────────────────────────────
// A new JSON route gets a tool here, calling the same query function through
// `deps.serve` with the route's cache name (and the same variant, so both
// doors fill one KV entry). Never a second query.

import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
  type CallToolResult,
} from '@modelcontextprotocol/server'
import { z } from 'zod'

import { ALERT_TIER_FILTERS } from '#shared/utils/terminal-tiers'

import type { PipelineDb } from '../pipeline/store'
import { collectStatus, type StatusConfig } from './fleet-status'
import {
  HIRING_WINDOW_DAYS,
  INCIDENT_HISTORY_DAYS,
  INCIDENT_WINDOW_DAYS,
  MOVEMENT_WINDOW_HOURS,
  queryAlert,
  queryAlerts,
  queryCoverage,
  queryHiring,
  queryHiringHistory,
  queryIncidents,
  queryOverview,
  queryPriceHistory,
  queryPrices,
  queryReleases,
  type QueryContext,
} from './terminal-db'
import { SHARE_WINDOW_DAYS, queryRankings } from './terminal-rankings'
import { PROVIDER_ORDER } from './terminal-sources'

/** What the server needs from its host — the route supplies the real thing, the test a fixture. */
export interface McpDeps {
  db: PipelineDb
  /**
   * Run `query` for the current tick, through the cache when there is one.
   * The route passes terminalPayload(); the test passes the query straight
   * through with a fixed clock. `variant` is anything that changes the
   * payload, exactly as the JSON routes key it.
   */
  serve<T>(name: string, query: (ctx: QueryContext) => Promise<T>, variant?: string): Promise<T>
  /** The site's llms.txt body — the same bytes GET /llms.txt serves. */
  llmsTxt: string
  /** Canonical origin, no trailing slash. */
  appUrl: string
  status: StatusConfig
}

export const MCP_SERVER_NAME = 'frontier-terminal'

/** The JSON API's alert cap — how far back get_alerts searches and get_alert looks. */
export const ALERT_SEARCH_DEPTH = 500

const ProviderSchema = z
  .enum(PROVIDER_ORDER)
  .describe('One of the four tracked labs: openai, anthropic, google, xai.')

// modelKey() output: `model:<provider>:<slug>[:<tier>]` (server/pipeline/contracts/keys.ts) —
// the same shape GET /api/prices/<key> accepts.
const SkuKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^model:[a-z]+:[^\s/]+$/)
  .describe('A SKU key as get_prices lists it in entity_key, e.g. model:xai:grok-4.6:standard.')

/**
 * The SDK's tool-result shape, with the payload sent twice on purpose: the
 * text block is what a client that ignores structuredContent (most of them,
 * today) shows the model, and structuredContent is what a client that
 * reads it gets without re-parsing. The spec recommends exactly this.
 */
function json<T extends object>(payload: T): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
  }
}

function failure(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const

const PROVENANCE =
  'Every row carries source_url (the exact page it was read from) and fetched_at (UTC). ' +
  'as_of is the poll tick the payload reflects; computed_at is when it was built (it may then be served from a five-minute cache).'

const INSTRUCTIONS =
  `${MCP_SERVER_NAME}: a free, public, read-only investor terminal tracking the frontier AI labs ` +
  '(OpenAI, Anthropic, Google, xAI) on five axes — API price lists, hiring boards, SEC filings, status-page incidents, ' +
  'and OpenRouter demand share. ' +
  'Not investment advice. Start with `describe` (the site map) or `get_overview` (what moved). ' +
  PROVENANCE

/** A fresh server with every tool and resource registered. One per request. */
export function createTerminalMcpServer(deps: McpDeps): McpServer {
  // The build sha is the honest version: this server has no release
  // number of its own, and the sha is what /api/status reports.
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: deps.status.buildSha || 'dev' },
    { instructions: INSTRUCTIONS },
  )

  const llmsUri = `${deps.appUrl}/llms.txt`
  server.registerResource(
    'llms.txt',
    llmsUri,
    {
      title: 'Site map for agents',
      description: 'What Frontier Terminal is and which pages are worth fetching (llmstxt.org).',
      mimeType: 'text/markdown',
    },
    () => ({ contents: [{ uri: llmsUri, mimeType: 'text/markdown', text: deps.llmsTxt }] }),
  )

  server.registerTool(
    'describe',
    {
      title: 'Describe the terminal',
      description:
        'Orientation: the site’s llms.txt — what it tracks, the provenance rule every number obeys, and the pages behind each tool. ' +
        'Call this first if you have not used this server before.',
      annotations: READ_ONLY,
    },
    () => ({ content: [{ type: 'text', text: deps.llmsTxt }] }),
  )

  server.registerTool(
    'get_overview',
    {
      title: 'What moved',
      description:
        `The signal band. movement counts change rows by axis (pricing, hiring, sec) inside a ${MOVEMENT_WINDOW_HOURS}h window ` +
        'anchored to the NEWEST detection (window_from..latest_detected_at), not to the clock — so a quiet weekend still reports Friday’s moves. ' +
        'total_changes is the all-time denominator; sources_not_yet_compared counts sources with a single snapshot (nothing to diff yet). ' +
        'alerts are the newest notable/critical rows with their cited change rows and alert_count the total on file; ticker is the ' +
        'info tier (what moved, low stakes) and ticker_count its total. ' +
        'A change row is a diff between two snapshots, never a re-read of current state. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () => json(await deps.serve('overview', (ctx) => queryOverview(deps.db, ctx))),
  )

  server.registerTool(
    'get_prices',
    {
      title: 'API prices',
      description:
        'The API price catalog: one row per SKU key (provider + model + tier) at its newest revision, in USD per million tokens ' +
        '(input_per_mtok, cached_input_per_mtok, output_per_mtok; null = the vendor publishes no figure), plus delta vs. the previous revision ' +
        'and removed=true for a delisted SKU. matrix is the like-for-like view: one flagship / balanced / economy cell per provider on the ' +
        'standard tier, each citing the vendor sentence (basis) that justifies the mapping, or a stated gap. ' +
        'OpenAI’s catalog page prints no prices, so its cells are gaps, not zeros. cross_check is OpenRouter: snapshotted as a drift check ' +
        'on the vendor pages, never a price of record. Optional provider filter narrows rows and matrix to one lab. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const prices = await deps.serve('prices', (ctx) => queryPrices(deps.db, ctx))
      if (!provider) return json(prices)
      const rows = prices.rows.filter((r) => r.provider === provider)
      const priced = (r: (typeof rows)[number]) =>
        r.input_per_mtok !== null || r.output_per_mtok !== null
      return json({
        ...prices,
        rows,
        matrix: {
          ...prices.matrix,
          providers: [provider],
          cells: prices.matrix.cells.filter((c) => c.provider === provider),
        },
        counts: {
          total: rows.length,
          priced: rows.filter((r) => !r.removed && priced(r)).length,
          catalog_only: rows.filter((r) => !r.removed && !priced(r)).length,
          removed: rows.filter((r) => r.removed).length,
        },
      })
    },
  )

  server.registerTool(
    'get_hiring',
    {
      title: 'Open roles',
      description:
        'Open roles per lab, counted from the CURRENT job-board set (a role missing from the board is closed), by department. ' +
        'feed says what the number is: ok, no_rows (feed registered, nothing parsed yet), or no_public_feed — Google, which has no ' +
        'public hiring feed, so its total is 0 with the audit’s reason rather than a guess. xAI’s board is blended with SpaceX ' +
        '(every row carries company_name "SpaceXAI"); the caveat and company_names travel with the row so you can say so. ' +
        'Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const hiring = await deps.serve('hiring', (ctx) => queryHiring(deps.db, ctx))
      if (!provider) return json(hiring)
      return json({ ...hiring, providers: hiring.providers.filter((p) => p.provider === provider) })
    },
  )

  server.registerTool(
    'get_alerts',
    {
      title: 'Alerts and ticker',
      description:
        'Alerts newest first, each citing the change rows it is a claim about (changes, resolved; missing_change_ids if any did not resolve). ' +
        'Severity reads as a tier: info is the ticker (what moved, low stakes — a role added, a title reworded); notable and critical are alerts ' +
        '(a price move, a new SKU, a department-level hiring shift, a filing). tier selects alert, ticker, or all (default all). ' +
        'rule is s1-floor (deterministic: a registration statement appeared on EDGAR) or agent-judge (a model’s reading of change rows, ' +
        'labelled as such). total is the count on file for the chosen tier. ' +
        `With a severity filter, the newest ${ALERT_SEARCH_DEPTH} rows of the tier are searched and up to limit returned. ` +
        PROVENANCE,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(ALERT_SEARCH_DEPTH).default(20),
        tier: z.enum(ALERT_TIER_FILTERS).default('all'),
        severity: z.enum(['info', 'notable', 'critical']).optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ limit, tier, severity }) => {
      const depth = severity ? ALERT_SEARCH_DEPTH : limit
      const alerts = await deps.serve(
        'alerts',
        (ctx) => queryAlerts(deps.db, ctx, depth, tier),
        `${tier}:${depth}`,
      )
      if (!severity) return json(alerts)
      return json({
        ...alerts,
        rows: alerts.rows.filter((a) => a.severity === severity).slice(0, limit),
      })
    },
  )

  server.registerTool(
    'get_alert',
    {
      title: 'One alert',
      description:
        'One alert by id (ids come from get_alerts, get_overview, the Atom feed or an /alerts/<id> permalink), with every cited change ' +
        'row in full: fields lists every scalar field before and after, unchanged ones included. ' +
        PROVENANCE,
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const detail = await deps.serve('alert', (ctx) => queryAlert(deps.db, ctx, id), id)
      if (!detail) return failure(`No alert with id ${id}.`)
      return json(detail)
    },
  )

  server.registerTool(
    'get_price_history',
    {
      title: 'One SKU’s price series',
      description:
        'Every observation of one SKU key, oldest first: points carry kind (baseline = the price as of the source’s first snapshot, ' +
        'added, modified with the changed fields in diff, removed, or current), the three USD-per-million-token figures, and the fetch ' +
        'each was read from. A series is one price per revision of the vendor page, not a daily sample — a flat line is a page that did ' +
        'not change. removed=true when the newest observation is a delisting. Keys come from get_prices (entity_key); an unknown key is ' +
        'an error, not an empty series. ' +
        PROVENANCE,
      inputSchema: z.object({ key: SkuKeySchema }),
      annotations: READ_ONLY,
    },
    async ({ key }) => {
      const history = await deps.serve(
        'price-history',
        (ctx) => queryPriceHistory(deps.db, ctx, key),
        key,
      )
      if (history === null) return failure(`No SKU with key ${key}. Keys are listed by get_prices.`)
      return json(history)
    },
  )

  server.registerTool(
    'get_hiring_history',
    {
      title: 'Open roles per day',
      description:
        'Open roles per lab and department, per UTC day (dates, total, departments[].series), RECONSTRUCTED by undoing the ' +
        'change log backwards from the current job-board set — not a series of daily snapshots. Each series starts at the ' +
        'provider’s earliest board snapshot (series_from); baseline_at is this store’s first poll, and roles that opened or closed ' +
        'before the log begins are carried as they stand today, so the oldest points understate churn. compare sets today ' +
        `against ${HIRING_WINDOW_DAYS} days back, or the series start when that is younger (days says which). log is the change ` +
        'rows the series rests on. Google is an audited cut (feed no_public_feed, reason given) with an empty series; xAI carries the ' +
        'SpaceXAI blend caveat. Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const history = await deps.serve('hiring-history', (ctx) => queryHiringHistory(deps.db, ctx))
      if (!provider) return json(history)
      return json({
        ...history,
        providers: history.providers.filter((p) => p.provider === provider),
      })
    },
  )

  server.registerTool(
    'get_releases',
    {
      title: 'Release timeline',
      description:
        'Every SKU first listed on a vendor page after that source’s baseline, newest first, with the price printed beside it ' +
        'when it was first seen (first_seen_at is the detection, not the vendor’s launch date) and also_listed_by for keys two ' +
        'pages carry. A row is an `added` change on a model entity — a listing event, so a rename or a tier split appears as a ' +
        'release. Baseline sightings are EXCLUDED: everything on a page at its first snapshot is a starting state, not a release, ' +
        'and excluded_baseline counts them; nothing before log_from could have been seen at all. Optional limit truncates rows ' +
        'and adds total. ' +
        PROVENANCE,
      inputSchema: z.object({ limit: z.number().int().min(1).max(500).optional() }),
      annotations: READ_ONLY,
    },
    async ({ limit }) => {
      const releases = await deps.serve('releases', (ctx) => queryReleases(deps.db, ctx))
      if (limit === undefined) return json(releases)
      return json({ ...releases, rows: releases.rows.slice(0, limit), total: releases.rows.length })
    },
  )

  server.registerTool(
    'get_incidents',
    {
      title: 'Status-page incidents',
      description:
        'Capacity strain as the vendor chose to post it: three status feeds (OpenAI and Anthropic Statuspage, Google Cloud ' +
        `filtered to Gemini / Vertex AI products). Per provider, incidents started in the newest ${INCIDENT_WINDOW_DAYS} days ` +
        '(last_window) against the same span before (prior_window), what is open now, and coverage_from — where held history ' +
        'begins; a Statuspage feed is a rolling window, so prior_window is partial until the pipeline has polled through it. ' +
        `incidents lists every one started inside ${INCIDENT_HISTORY_DAYS} days, newest first, with impact in the vendor’s own ` +
        'vocabulary (never mapped across vendors) and a link. Windows anchor on window_to, the newest status fetch, not the ' +
        'clock. Not an SLA and not comparable across vendors: OpenAI’s feed mixes ChatGPT with API incidents and has no component ' +
        'field. xAI has NO public feed (its status API answers 403 to non-browsers) and is reported as no_public_feed with the ' +
        'reason, never as zero incidents. Optional provider filter narrows providers and incidents. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const incidents = await deps.serve('incidents', (ctx) => queryIncidents(deps.db, ctx))
      if (!provider) return json(incidents)
      return json({
        ...incidents,
        providers: incidents.providers.filter((p) => p.provider === provider),
        incidents: incidents.incidents.filter((i) => i.provider === provider),
      })
    },
  )

  server.registerTool(
    'get_rankings',
    {
      title: 'Demand share (OpenRouter)',
      description:
        'OpenRouter’s daily usage rankings folded into token share per lab over the newest ' +
        `${SHARE_WINDOW_DAYS} days present (shares[].share, 0..1) with the change against the ${SHARE_WINDOW_DAYS} before ` +
        '(delta_pp, percentage points; null when there is no prior window), each lab’s top models in the window, and a daily ' +
        'series. This is OpenRouter share — one aggregator’s routed traffic, top 50 models a day plus an aggregated `other` — ' +
        'NOT market share, revenue share or total usage; say so when you cite it. Windows are days present in the store, ' +
        'not calendar days (meta.coverage names them). status is ok, not_configured (no API key on the poller, nothing fetched) ' +
        'or no_rows. The data is CC BY 4.0 and republication requires the citation carried in meta.citation, with OpenRouter’s ' +
        'own meta.as_of filled in; reproduce it beside any figure you quote. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () => json(await deps.serve('rankings', (ctx) => queryRankings(deps.db, ctx))),
  )

  server.registerTool(
    'get_coverage',
    {
      title: 'Source coverage',
      description:
        'Every registered source: its audited URL, role (primary, join, cross-check, sec), the audit’s caveat in its own words, ' +
        'newest snapshot (with HTTP status and byte count), how the last poll ended (ok, unchanged, failed, baseline), snapshot count ' +
        'and how many current rows came from it. cuts lists what is deliberately NOT tracked and why. totals are table row counts; ' +
        'exports describes the CSV/JSON bulk downloads at /export/<table>.csv|json. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () => json(await deps.serve('coverage', (ctx) => queryCoverage(deps.db, ctx))),
  )

  server.registerTool(
    'get_status',
    {
      title: 'Deployment status',
      description:
        'Is what is running the thing that was meant to be running: build sha, migrations the repo has vs. the ones production applied ' +
        '(pending non-empty = a deploy outran its migration), the cron map, and the newest fetch per source. ' +
        'status is ok, degraded (migrations pending) or down (database unreachable). Not cached. No secrets.',
      annotations: READ_ONLY,
    },
    async () => json((await collectStatus(deps.db, deps.status)).payload),
  )

  return server
}

/**
 * One fetch-shaped handler serving both protocol eras, stateless, JSON.
 * Build once per isolate and call per request; every request still gets its
 * own server instance.
 */
export function createTerminalMcpHandler(deps: McpDeps): (request: Request) => Promise<Response> {
  const modern = createMcpHandler(() => createTerminalMcpServer(deps), { responseMode: 'json' })

  return async (request) => {
    if (!(await isLegacyRequest(request))) return modern.fetch(request)
    // A GET (the server-push SSE stream) or DELETE (session end) has no
    // meaning without a session. The spec allows 405 for both, and it is the
    // answer the SDK's own stateless fallback gives; the bare transport would
    // instead open an idle keep-alive stream, which on a Worker is a request
    // that never ends and never says anything.
    if (request.method !== 'POST') {
      return new Response('Method not allowed.', { status: 405, headers: { Allow: 'POST' } })
    }
    // The stateless legacy idiom, with JSON rather than a one-event SSE
    // stream — the one thing the SDK's built-in fallback does not offer.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    const server = createTerminalMcpServer(deps)
    await server.connect(transport)
    try {
      return await transport.handleRequest(request)
    } finally {
      await transport.close()
    }
  }
}
