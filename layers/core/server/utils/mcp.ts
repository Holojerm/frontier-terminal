// The MCP server: the terminal's read-only query layer over Streamable HTTP at
// /mcp (layers/core/server/routes/mcp.ts).
//
// It lives inside the one Worker: a second Worker calling the JSON API would
// funnel every MCP user through one egress IP into the per-IP rate limit. Here
// every tool calls its JSON route's query function, reads the same KV entry
// (terminalPayload), and is rate-limited per client IP by the same rateLimit().
// No auth: the data is public.
//
// Stateless and JSON on both protocol eras: a fresh McpServer per request, so no
// isolate holds a session. Legacy (2025-era) clients go through a per-request
// WebStandardStreamableHTTPServerTransport, modern (2026-07-28) ones through
// createMcpHandler, the split the SDK documents on isLegacyRequest().
//
// A new JSON route gets a tool in its domain's file under server/mcp/ (listed in
// server/registries/mcp-tools.ts) that calls the same query through `deps.serve`
// with the route's cache name and variant, so both fill one KV entry.

import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from '@modelcontextprotocol/server'

import { MCP_INSTRUCTIONS, MCP_TOOLS } from '#server/registries/mcp-tools'

/** What the server needs from its host: the route supplies the real thing, the test a fixture. */
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
  /** The site's llms.txt body: the same bytes GET /llms.txt serves. */
  llmsTxt: string
  /** Canonical origin, no trailing slash. */
  appUrl: string
  status: StatusConfig
}

/** A fresh server with every tool and resource registered. One per request. */
export function createTerminalMcpServer(deps: McpDeps): McpServer {
  // The build sha is the honest version: this server has no release
  // number of its own, and the sha is what /api/status reports.
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: deps.status.buildSha || 'dev' },
    { instructions: MCP_INSTRUCTIONS },
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
  for (const register of MCP_TOOLS) register(kit)

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
    // stream, which the SDK's built-in fallback does not offer.
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
