// The MCP server: the terminal's read-only query layer, exposed to an agent
// over Streamable HTTP at /mcp (layers/terminal/server/routes/mcp.ts).
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
// McpServer — some forty registrations, cheap — so a Worker isolate holds no
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
// A new JSON route gets a tool in its domain's file under server/mcp/ (a new
// domain is a new file, registered in createTerminalMcpServer below), calling
// the same query function through `deps.serve` with the route's cache name (and
// the same variant, so both doors fill one KV entry). Never a second query.

import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from '@modelcontextprotocol/server'

import type { PipelineDb } from '../pipeline/store'
import { type StatusConfig } from '#server/utils/fleet-status'
import { type AsOfPayload } from './terminal-asof'
import { type QueryContext } from './terminal-db'
import type { RebuiltAsOf } from './terminal-handler'
import { registerAlertTools } from '../mcp/alerts'
import { registerPriceTools } from '../mcp/prices'
import { registerHiringTools } from '../mcp/hiring'
import { registerOperationsTools } from '../mcp/operations'
import { registerDemandTools } from '../mcp/demand'
import { registerFilingTools } from '../mcp/filings'
import { registerExposureTools } from '../mcp/exposure'
import { registerFeedTools } from '../mcp/feed'
import { registerComputeTools } from '../mcp/compute'
import { registerThesisTools } from '../mcp/theses'
import { registerSignalTools } from '../mcp/signals'
import { READ_ONLY, PROVENANCE, makeRead } from '../mcp/kit'

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
  /**
   * `serve` as of the instant `at`, for a tool given `as_of`: the route passes
   * terminalPayloadAt(), which refuses an instant `asOf` cannot answer with a
   * 400 and adds point_in_time to the payload.
   */
  serveAt<T extends object | null>(
    name: string,
    at: string,
    query: (ctx: QueryContext) => Promise<T>,
    variant?: string,
    asOf?: RebuiltAsOf,
  ): Promise<AsOfPayload<T>>
  /** The site's llms.txt body — the same bytes GET /llms.txt serves. */
  llmsTxt: string
  /** Canonical origin, no trailing slash. */
  appUrl: string
  status: StatusConfig
}

export const MCP_SERVER_NAME = 'frontier-terminal'

const INSTRUCTIONS =
  `${MCP_SERVER_NAME}: a free, public, read-only terminal of fundamentals on the frontier AI labs ` +
  '(OpenAI, Anthropic, Google, xAI, Meta, Mistral, DeepSeek, Alibaba (Qwen), Moonshot AI (Kimi)) and the public companies around them. ' +
  'Per lab: API price lists, hiring boards (with the physical-infrastructure buildout cluster) and posted pay (get_pay), SEC filings and disclosed revenue, ' +
  'status-page incidents, latency probes and published rate limits (get_rate_limits), misalignment disclosures, OpenRouter demand share with its implied spend share, ' +
  'and adoption outside the labs’ own numbers (get_adoption). ' +
  'Around the labs: hyperscaler exposure, what Microsoft and Amazon file about OpenAI and Anthropic (get_parents), who sells to and funds whom, suppliers, listed companies, ' +
  'compute (GPU rental prices, utilization readings in get_utilization, Epoch AI’s data-center power in get_datacenters, who powers each lab site in get_power_sites, grid load where those sites are in get_grid_load), the hardware layer’s monthly prints, point in time (get_hardware_prints), ' +
  'press-reported revenue, valuations and funding (get_reported), and those reports scored against later filings (get_ground_truth), and what the listed companies guided on their earnings calls, scored the same way (get_call_guidance). ' +
  'Theses (get_theses) are arguments built on this data, each claim checked against a kill condition. ' +
  'The signal scorecard (get_signals) tests each series against the stocks it is expected to lead, with a held-out sample. ' +
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
        'Orientation: the site’s llms.txt — what it tracks, the provenance rule every number obeys, the data license, and the pages behind each tool. ' +
        'Call this first if you have not used this server before.',
      annotations: READ_ONLY,
    },
    () => ({ content: [{ type: 'text', text: deps.llmsTxt }] }),
  )

  const kit = { server, deps, read: makeRead(deps) }
  registerAlertTools(kit)
  registerPriceTools(kit)
  registerHiringTools(kit)
  registerOperationsTools(kit)
  registerDemandTools(kit)
  registerFilingTools(kit)
  registerExposureTools(kit)
  registerComputeTools(kit)
  registerThesisTools(kit)
  registerSignalTools(kit)
  registerFeedTools(kit)

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
