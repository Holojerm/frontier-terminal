// /mcp — the MCP endpoint (Streamable HTTP), every method. POST carries the
// JSON-RPC traffic; GET and DELETE are session operations, which a stateless
// server answers 405. The server itself, and why it lives in this Worker,
// is server/utils/mcp.ts.
//
// Rate-limited per client IP exactly like the JSON routes, on the same
// budget: one MCP exchange is one request, and an agent that loops is the
// same abuse as a script that loops.

import { db } from '@nuxthub/db'
import { toWebRequest } from 'h3'

import { createTerminalMcpHandler } from '../utils/mcp'
import { llmsTxtResponse } from '../utils/seo'
import { terminalPayload } from '../utils/terminal-handler'

// Built on first use, per isolate: runtime config is fixed for the life of
// the isolate, and the modern-era handler is meant to be constructed once.
let handler: ((request: Request) => Promise<Response>) | undefined

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'mcp', limit: 60, windowSeconds: 60 })
  setResponseHeader(event, 'Cache-Control', 'no-store')

  if (!handler) {
    const config = useRuntimeConfig(event)
    const { body: llmsTxt } = llmsTxtResponse({
      appName: config.public.appName,
      appUrl: config.public.appUrl,
      description: config.public.appDescription,
      pages: config.publicPages ?? [],
      complete: true,
    })
    handler = createTerminalMcpHandler({
      db,
      serve: terminalPayload,
      llmsTxt,
      appUrl: config.public.appUrl.replace(/\/+$/, ''),
      status: {
        buildSha: config.public.buildSha,
        buildDate: config.buildDate,
        scheduledTasks: config.scheduledTasks,
      },
    })
  }

  return handler(toWebRequest(event))
})
