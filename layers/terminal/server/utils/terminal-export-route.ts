// Both /export routes are this one handler: table lookup, format, the 404,
// rate limiting, and the stream. See parseExportPath for why the route
// files themselves decide nothing.

import type { H3Event } from 'h3'

import { csvChunks, exportTable, jsonChunks, parseExportPath, streamOf } from './terminal-export'
import { terminalDb } from './terminal-handler'

const FORMATS = {
  csv: { chunks: csvChunks, contentType: 'text/csv; charset=utf-8' },
  json: { chunks: jsonChunks, contentType: 'application/json; charset=utf-8' },
} as const

export async function serveExport(event: H3Event) {
  // Exports walk whole tables; 30/min matches the native limiter's budget.
  await rateLimit(event, { name: 'export', limit: 30, windowSeconds: 60 })

  const parsed = parseExportPath(event.path)
  const table = parsed && exportTable(parsed.name)
  if (!parsed || !table) {
    throw createError({ statusCode: 404, message: `No export at ${event.path.split('?')[0]}` })
  }

  const { chunks, contentType } = FORMATS[parsed.format]
  setResponseHeader(event, 'Content-Type', contentType)
  setResponseHeader(
    event,
    'Content-Disposition',
    `attachment; filename="${table.name}.${parsed.format}"`,
  )
  // Rows can change every tick; a proxy may hold an export for a minute.
  setResponseHeader(event, 'Cache-Control', 'public, max-age=60')
  return sendStream(event, streamOf(chunks(terminalDb, table)))
}
