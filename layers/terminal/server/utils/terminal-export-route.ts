// Both /export routes are this one handler: table lookup, format, the 404,
// rate limiting, `as_of`, the license window, and the stream. See
// parseExportPath for why the route files themselves decide nothing.

import type { H3Event } from 'h3'

import { HISTORY_LICENSE, PAID_LICENSE, licenseSplit } from '#shared/utils/license'
import { cacheControlFor, rateLimitTerminal } from './api-access'
import { SCHEMA_VERSION, SCHEMA_VERSION_HEADER } from './data-schema'
import { PointInTimeError, assertKnowable } from './terminal-asof'
import { DICTIONARY_NAME, dataDictionary, dictionaryCsv } from './terminal-dictionary'
import {
  EXPORT_TABLES,
  LICENSE_COLUMN,
  csvChunks,
  exportFilter,
  exportTable,
  jsonChunks,
  jsonEnvelopeChunks,
  licenseHeaders,
  licenseWindow,
  parseExportPath,
  parseExportQuery,
  sampleOf,
  streamOf,
  WITHDRAWN_EXPORTS,
  type ExportTable,
} from './terminal-export'
import { terminalDb } from './terminal-handler'

const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
} as const

/** The export tables that answer `as_of` — every one but those rewritten in place with no log. */
export const AS_OF_EXPORTS = Object.values(EXPORT_TABLES)
  .filter((t) => t.asOfRefusal === null)
  .map((t) => t.name)

/** `sample`: the first SAMPLE_ROWS rows only, for /export/sample/<table>.<format>. */
export async function serveExport(event: H3Event, options: { sample?: boolean } = {}) {
  const parsed = parseExportPath(event.path)

  // /export/dictionary.<format> lands on these catch-alls too (see
  // parseExportPath). It reads no database, so it skips the export budget,
  // which /data's server render would otherwise spend on every view.
  if (parsed?.name === DICTIONARY_NAME && !options.sample) {
    const dictionary = dataDictionary()
    setResponseHeader(event, 'Cache-Control', 'public, max-age=300')
    setResponseHeader(event, SCHEMA_VERSION_HEADER, SCHEMA_VERSION)
    if (parsed.format === 'json') return dictionary
    setResponseHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    setResponseHeader(event, 'Content-Disposition', 'attachment; filename="dictionary.csv"')
    return dictionaryCsv(dictionary)
  }

  // Exports walk whole tables; 30/min matches the native limiter's budget. A
  // key gets KEYED_EXPORT_LIMIT, and the bulk feed for the rest.
  const key = await rateLimitTerminal(event, {
    name: 'export',
    limit: 30,
    windowSeconds: 60,
    budget: 'export',
  })
  // A key changes the license on rows older than the window, nothing else.
  const older = key ? PAID_LICENSE : HISTORY_LICENSE

  if (parsed && Object.hasOwn(WITHDRAWN_EXPORTS, parsed.name)) {
    throw createError({ statusCode: 410, message: WITHDRAWN_EXPORTS[parsed.name] })
  }
  const full = parsed && exportTable(parsed.name)
  if (!parsed || !full) {
    throw createError({ statusCode: 404, message: `No export at ${event.path.split('?')[0]}` })
  }

  // Column filters (`?recipe_id=`) first: a parameter the table does not
  // declare is refused (a sample declares none), and exportFilter leaves
  // as_of to ExportTable.at and history to licenseWindow.
  const filter = exportFilter(options.sample ? sampleOf(full) : full, getQuery(event))
  if ('error' in filter) throw createError({ statusCode: 400, message: filter.error })

  const { as_of, history } = await getValidatedQuery(event, parseExportQuery)
  let rebuilt: ExportTable = full
  if (as_of !== undefined) {
    await badRequestOn(() => assertKnowable(terminalDb, as_of))
    rebuilt = await badRequestOn(
      () => full.at(terminalDb, as_of),
      (reason) =>
        `as_of is not supported on /export/${full.name}: ${reason} Exports that answer as_of: ${AS_OF_EXPORTS.join(', ')}.`,
    )
  }

  const window = await badRequestOn(async () =>
    licenseWindow(full.name, rebuilt, { as_of, history }, undefined, older),
  )
  // A sample is the first rows of what the same URL without /sample serves.
  const table = options.sample ? sampleOf(window.table) : window.table

  setResponseHeader(event, 'Content-Type', CONTENT_TYPES[parsed.format])
  const suffix =
    (options.sample ? '-sample' : '') +
    (window.split && history === 'full' ? '.full_history' : '') +
    (as_of === undefined ? '' : `.as_of_${as_of.replace(/[:.]/g, '-')}`)
  setResponseHeader(
    event,
    'Content-Disposition',
    `attachment; filename="${table.name}${suffix}.${parsed.format}"`,
  )
  for (const [name, value] of Object.entries(licenseHeaders(window))) {
    setResponseHeader(event, name, value)
  }
  // Rows can change every tick; a proxy may hold an export for a minute.
  // The query string is part of any proxy's key, so as_of never shares one.
  setResponseHeader(event, 'Cache-Control', cacheControlFor(event, 'public, max-age=60'))
  // A JSON export is a bare array unless it carries its license, so the
  // schema version travels as a header on every one.
  setResponseHeader(event, SCHEMA_VERSION_HEADER, SCHEMA_VERSION)

  const chunks =
    parsed.format === 'csv'
      ? csvChunks(terminalDb, table, filter.where)
      : window.split
        ? jsonEnvelopeChunks(terminalDb, table, filter.where, {
            schema_version: SCHEMA_VERSION,
            table: full.name,
            as_of: as_of ?? null,
            history: history ?? 'recent',
            license: licenseSplit(undefined, older),
            license_column: LICENSE_COLUMN,
          })
        : jsonChunks(terminalDb, table, filter.where)
  return sendStream(event, streamOf(chunks))
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
