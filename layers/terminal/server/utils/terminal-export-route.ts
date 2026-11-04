// Both /export routes are this one handler: table lookup, format, the 404,
// rate limiting, `as_of`, and the stream. See parseExportPath for why the
// route files themselves decide nothing.

import type { H3Event } from 'h3'

import { PointInTimeError, assertKnowable, parseAsOfQuery } from './terminal-asof'
import {
  EXPORT_TABLES,
  csvChunks,
  exportFilter,
  exportTable,
  jsonChunks,
  parseExportPath,
  sampleOf,
  streamOf,
  WITHDRAWN_EXPORTS,
  type ExportTable,
} from './terminal-export'
import { terminalDb } from './terminal-handler'

const FORMATS = {
  csv: { chunks: csvChunks, contentType: 'text/csv; charset=utf-8' },
  json: { chunks: jsonChunks, contentType: 'application/json; charset=utf-8' },
} as const

/** The export tables that answer `as_of` — every one but those rewritten in place with no log. */
export const AS_OF_EXPORTS = Object.values(EXPORT_TABLES)
  .filter((t) => t.asOfRefusal === null)
  .map((t) => t.name)

/** `sample`: the first SAMPLE_ROWS rows only, for /export/sample/<table>.<format>. */
export async function serveExport(event: H3Event, options: { sample?: boolean } = {}) {
  // Exports walk whole tables; 30/min matches the native limiter's budget.
  await rateLimit(event, { name: 'export', limit: 30, windowSeconds: 60 })

  const parsed = parseExportPath(event.path)
  if (parsed && Object.hasOwn(WITHDRAWN_EXPORTS, parsed.name)) {
    throw createError({ statusCode: 410, message: WITHDRAWN_EXPORTS[parsed.name] })
  }
  const full = parsed && exportTable(parsed.name)
  const found = full && options.sample ? sampleOf(full) : full
  if (!parsed || !found) {
    throw createError({ statusCode: 404, message: `No export at ${event.path.split('?')[0]}` })
  }

  // Column filters (`?recipe_id=`) first: a parameter the table does not
  // declare is refused, and exportFilter leaves as_of to ExportTable.at.
  const filter = exportFilter(found, getQuery(event))
  if ('error' in filter) throw createError({ statusCode: 400, message: filter.error })

  const { as_of } = await getValidatedQuery(event, parseAsOfQuery)
  let table: ExportTable = found
  if (as_of !== undefined) {
    await badRequestOn(() => assertKnowable(terminalDb, as_of))
    table = await badRequestOn(
      () => found.at(terminalDb, as_of),
      (reason) =>
        `as_of is not supported on /export/${found.name}: ${reason} Exports that answer as_of: ${AS_OF_EXPORTS.join(', ')}.`,
    )
  }

  const { chunks, contentType } = FORMATS[parsed.format]
  setResponseHeader(event, 'Content-Type', contentType)
  const suffix =
    (options.sample ? '-sample' : '') +
    (as_of === undefined ? '' : `.as_of_${as_of.replace(/[:.]/g, '-')}`)
  setResponseHeader(
    event,
    'Content-Disposition',
    `attachment; filename="${table.name}${suffix}.${parsed.format}"`,
  )
  // Rows can change every tick; a proxy may hold an export for a minute.
  // The query string is part of any proxy's key, so as_of never shares one.
  setResponseHeader(event, 'Cache-Control', 'public, max-age=60')
  return sendStream(event, streamOf(chunks(terminalDb, table, filter.where)))
}

/** Run `fn`, turning a PointInTimeError into a 400 that says why. */
async function badRequestOn<T>(
  fn: () => Promise<T>,
  say: (reason: string) => string = (reason) => reason,
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (!(error instanceof PointInTimeError)) throw error
    throw createError({ statusCode: 400, message: say(error.message) })
  }
}
