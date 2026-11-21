// Every public URL a crawler document names, and the /llms.txt input built from them. One
// place because three readers need the same answer: sitemap.xml, /llms.txt, and the MCP
// `describe` tool, which hands an agent the llms.txt body.

import manifest from '~~/fleet.json'
import { THESES } from '../../../theses/server/theses/registry'
import { EXPORT_TABLES } from '#server/registries/export-tables'

/** The route-table pages plus the dynamic ones enumerable without a query. */
export function crawlerPages(publicPages: PublicPage[] | undefined): PublicPage[] {
  return [
    ...(publicPages ?? []),
    ...LAB_PAGES,
    ...TEAR_SHEET_PAGES,
    ...COMPARE_PAGES,
    ...thesisPages(THESES),
  ]
}

/** The pages that read only some labs, dated by those labs' changes (seo.ts › dataLastmods). */
export function labScopedPages(): Record<string, readonly string[]> {
  return Object.fromEntries([
    ...[...LAB_PAGES, ...TEAR_SHEET_PAGES].map((page) => [page.path, [page.lab]] as const),
    ...COMPARE_PAGES.map((page) => [page.path, page.labs] as const),
  ])
}

export function llmsTxtInput(config: {
  appName: string
  appUrl: string
  appDescription: string
  publicPages: PublicPage[] | undefined
}): LlmsTxtInput {
  return {
    appName: config.appName,
    appUrl: config.appUrl,
    description: config.appDescription,
    pages: crawlerPages(config.publicPages),
    tables: Object.values(EXPORT_TABLES).map((table) => ({
      name: table.name,
      description: table.description,
    })),
    repoUrl: manifest.links.github ?? '',
    sections: [DICTIONARY, IDENTIFIERS, POINT_IN_TIME, BULK_FEED],
  }
}

/** The security-master join (terminal-identifiers.ts, /data#security-master). */
const IDENTIFIERS: LlmsTxtSection = {
  heading: 'Joining to your security master',
  links: [
    {
      path: '/api/identifiers',
      title: 'Identifiers API',
      description:
        'One row per company we name, with its legal name, country, listing status, CIK, LEI, and for a listed company its ticker, MIC, and US composite FIGI. Each identifier has the URL and time we read it from SEC, GLEIF, or OpenFIGI, and a null LEI says why. securities lists which listed security carries each lab (itself, a parent, or a disclosed investor) and the filing that discloses it. Add ?entity=<id> for one company. The MCP tool is get_identifiers.',
    },
    {
      path: '/export/entity_identifiers.csv',
      title: 'entity_identifiers export',
      description:
        'The same rows as a CSV or JSON download. entity_id is the value of every provider and company column in the other tables, so join on it. Tables with cik or ticker join on those too. The data dictionary names each table’s join columns.',
    },
  ],
}

/** The per-column documentation of the tables above (terminal-dictionary.ts). */
const DICTIONARY: LlmsTxtSection = {
  heading: 'Data dictionary',
  links: [
    {
      path: `/export/${DICTIONARY_NAME}.json`,
      title: 'Data dictionary (JSON)',
      description:
        'Every exported column of every table, with its type (text, integer, number, ISO-8601 timestamp, date, JSON, boolean), unit, whether it can be null, whether it is part of the row key or provenance, and what it holds. Each table also gives its grain, update cadence, event-time and knowledge-time columns, how ?as_of= answers, where its history starts, the identifier columns to join on, and whether it can be used commercially (from each source’s rights in sources.yaml). sources lists every source’s commercial-use answer. The same entries are on /data, one section per table.',
    },
    {
      path: `/export/${DICTIONARY_NAME}.csv`,
      title: 'Data dictionary (CSV)',
      description: 'The same entries, one row per table and column.',
    },
  ],
}

const refusingAsOf = Object.values(EXPORT_TABLES)
  .filter((t) => t.pointInTime === 'refused')
  .map((t) => t.name)

const EXAMPLE_AS_OF = '2026-10-01T00:00:00Z'

/** /api/exposure dates a fact by its filing, not our fetch, so llms.txt names it apart. */
const FILED_AS_OF_ROUTE = '/api/exposure'
const FETCHED_AS_OF_ROUTES = AS_OF_ROUTES.filter((r: string) => r !== FILED_AS_OF_ROUTE)

/** `?as_of=` on the routes and exports that answer it (terminal-asof.ts). */
const POINT_IN_TIME: LlmsTxtSection = {
  heading: 'Point in time',
  links: [
    {
      path: `/api/prices?as_of=${EXAMPLE_AS_OF}`,
      title: 'API as_of',
      description: `Add \`?as_of=<ISO-8601 timestamp with zone>\` to ${FETCHED_AS_OF_ROUTES.join(', ')} to see what we knew at that moment. That’s when we fetched the data, not when the event happened. A row counts from its fetch, and a judge alert from a judge run that could have written it. The response’s as_of becomes our last check before that moment, and point_in_time says how the answer was rebuilt and which keys the change log can’t confirm (unverified). ${FILED_AS_OF_ROUTE} takes as_of too, and keeps the facts filed before that UTC day, back to 2020. Every other route answers 400 instead of ignoring it.`,
    },
    {
      path: `/export/changes.csv?as_of=${EXAMPLE_AS_OF}`,
      title: 'Exports as_of',
      description: `The same parameter works on /export/<table>. Tables that only grow are cut at that moment. Current-state tables are rebuilt from the change log, with an as_of_verified column. ${refusingAsOf.join(', ')} answer 400, and the data dictionary says why for each.`,
    },
  ],
}

/** The bulk feed, reliability, and the schema version (/data#bulk, /data#schema). */
const BULK_FEED: LlmsTxtSection = {
  heading: 'Bulk feed and schema versions',
  links: [
    {
      path: '/export/bulk/manifest.json',
      title: 'Bulk manifest',
      description:
        'One gzipped CSV per table, rebuilt once a day, and the same rows as Parquet (gzip, columns typed by the data dictionary) under parquet. Each entry has the file URL, rows, bytes, SHA-256, generated_at, schema_version, and license. It lists the trailing-window files (CC BY 4.0). Sync by comparing SHA-256s. The manifest and files answer If-None-Match with a 304, and the files answer Range requests, so DuckDB can read a Parquet URL in place.',
    },
    {
      path: '/api/reliability',
      title: 'Reliability',
      description:
        'How the feed itself has performed, from stored records. Each source’s good checks over 30 and 90 days and its longest gap between good checks. Periods when our data was older than we say it is. For each filing our rules alerted on, the minutes from EDGAR’s acceptance time to our alert. Each deploy’s smoke test from GitHub Actions. The corrections log. The same figures are on /data#reliability.',
    },
    {
      path: '/data#schema',
      title: `Schema version ${SCHEMA_VERSION}`,
      description: `Every export and /api JSON response states schema_version (a field, or the X-Schema-Version header on CSV and JSON arrays). Adding a column is a minor version. Removing or renaming one is a major version with ${BREAKING_NOTICE_DAYS} days’ notice in the changelog. The changelog is under changelog in /export/dictionary.json.`,
    },
  ],
}
