// What every tool module shares: the result shapes, the argument schemas,
// the provenance and license text, and the read that serves a payload now or as of a time.

import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  DATA_LICENSE,
  HISTORY_LICENSE,
  LICENSE_SPLIT_EFFECTIVE,
  LICENSE_WINDOW_DAYS,
} from '#shared/utils/license'
import { PointInTimeError, parseAsOfQuery } from '../utils/terminal-asof'
import type { QueryContext } from '../utils/terminal-db'
import { PROVIDER_ORDER } from '../utils/terminal-sources'
import type { RebuiltAsOf } from '../utils/terminal-handler'
import type { McpServer } from '@modelcontextprotocol/server'
import type { McpDeps } from '../utils/mcp'

/** The JSON API's alert cap — how far back get_alerts searches and get_alert looks. */
export const ALERT_SEARCH_DEPTH = 500

export const ProviderSchema = z
  .enum(PROVIDER_ORDER)
  .describe(
    'One of the nine tracked labs: openai, anthropic, google, xai, meta, mistral, deepseek, alibaba, moonshot.',
  )

// modelKey() output: `model:<provider>:<slug>[:<tier>]` (layers/terminal/server/pipeline/contracts/keys.ts) —
// the same shape GET /api/prices/<key> accepts.
export const SkuKeySchema = z
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
export function json<T extends object>(payload: T): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
  }
}

export function failure(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

export const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const

// Validated in the handler (parseAsOfQuery), not in the schema: a transform
// does not survive the conversion to the JSON Schema a client is shown.
export const AsOfSchema = z
  .string()
  .optional()
  .describe(
    'Optional point in time, an ISO-8601 timestamp with a zone (e.g. 2026-10-01T12:00:00Z): the payload as the terminal ' +
      'knew it then, rebuilt from stored history, with point_in_time saying how (method) and which keys the change log ' +
      'cannot confirm (unverified). Omit for now.',
  )

/** A 400 from a point-in-time read (a bad or too-early as_of) is the caller's to fix: say it as a tool error. */
export async function asOfErrors(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run()
  } catch (error) {
    const status = (error as { statusCode?: unknown }).statusCode
    if (error instanceof Error && (error instanceof PointInTimeError || status === 400)) {
      return failure(error.message)
    }
    throw error
  }
}

export const LICENSE =
  `license names the data license, split by age: our compilation and derived numbers from the last ${LICENSE_WINDOW_DAYS} days are ${DATA_LICENSE.short}, ` +
  `older ones ${HISTORY_LICENSE.short} (non-commercial use only), except what we published before ${LICENSE_SPLIT_EFFECTIVE}, which stays ${DATA_LICENSE.short}. ` +
  `A result with as_of older than ${LICENSE_WINDOW_DAYS} days is labeled ${HISTORY_LICENSE.id} in point_in_time.license. Upstream data keeps its own license.`

export const PROVENANCE =
  'Every row carries source_url (the exact page it was read from) and fetched_at (UTC), the fetch that produced its current values; ' +
  'it only moves when they change. A current price row also carries checked_at, the newest read of that page that still showed it, or null. ' +
  'as_of is the newest poll the payload reflects. computed_at is when it was built: a payload is reused until new data arrives, so it can be older than your request. ' +
  LICENSE

/** A payload now, or as of `as_of` when the tool was given one. */
export function makeRead(deps: McpDeps) {
  return async <T extends object | null>(
    name: string,
    as_of: string | undefined,
    query: (ctx: QueryContext) => Promise<T>,
    variant?: string,
    asOf: RebuiltAsOf = 'snapshot',
  ) => {
    if (as_of === undefined) return deps.serve(name, query, variant)
    const at = parseAsOfQuery({ as_of }).as_of!
    return deps.serveAt(name, at, query, variant, asOf)
  }
}

export interface McpKit {
  server: McpServer
  deps: McpDeps
  read: ReturnType<typeof makeRead>
}
