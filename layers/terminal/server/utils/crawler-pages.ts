// Every public URL a crawler document names, and the /llms.txt input built
// from them — in one place because three readers need the same answer:
// sitemap.xml, /llms.txt, and the MCP `describe` tool, which hands an agent
// the llms.txt body. The MCP copy once listed only the route-table pages, so
// an agent asking what the site holds was never told the lab pages, the
// theses, or the bulk tables existed.

import type { PublicPage } from '#shared/utils/site'
import { COMPARE_PAGES } from '../../shared/utils/terminal-compare'
import { LAB_PAGES, TEAR_SHEET_PAGES } from '../../shared/utils/terminal-lab-summary'
import { thesisPages } from '../../shared/utils/thesis-format'

import manifest from '~~/fleet.json'
import { THESES } from '../theses/registry'
import type { LlmsTxtInput, LlmsTxtSection } from '#server/utils/seo'
import { REQUEST_BUDGETS } from '../../shared/utils/institutional'
import { WEBHOOK_HEADERS, WEBHOOK_RETRY_HOURS } from '../../shared/utils/webhooks'
import { BREAKING_NOTICE_DAYS, SCHEMA_VERSION } from './data-schema'
import { AS_OF_ROUTES } from './terminal-asof'
import { DICTIONARY_NAME } from './terminal-dictionary'
import { EXPORT_TABLES } from './terminal-export'

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
    sections: [DICTIONARY, IDENTIFIERS, POINT_IN_TIME, INSTITUTIONS],
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
        'Every exported column of every table, with its type (text, integer, number, ISO-8601 timestamp, date, JSON, boolean), unit, whether it can be null, whether it is part of the row key or provenance, and what it holds. Each table also gives its grain, update cadence, event-time and knowledge-time columns, how ?as_of= answers, where its history starts, the identifier columns to join on, and whether a licensee can use it commercially (from each source’s rights in sources.yaml). sources lists every source’s commercial-use answer. The same entries are on /data, one section per table.',
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

/** `?as_of=` on the routes and exports that answer it (terminal-asof.ts). */
const POINT_IN_TIME: LlmsTxtSection = {
  heading: 'Point in time',
  links: [
    {
      path: `/api/prices?as_of=${EXAMPLE_AS_OF}`,
      title: 'API as_of',
      description: `Add \`?as_of=<ISO-8601 timestamp with zone>\` to ${AS_OF_ROUTES.join(', ')} to see what we knew at that moment. That’s when we fetched the data, not when the event happened. A row counts from its fetch, and a judge alert from a judge run that could have written it. The response’s as_of becomes our last check before that moment, and point_in_time says how the answer was rebuilt and which keys the change log can’t confirm (unverified). Every other route answers 400 instead of ignoring it.`,
    },
    {
      path: `/export/changes.csv?as_of=${EXAMPLE_AS_OF}`,
      title: 'Exports as_of',
      description: `The same parameter works on /export/<table>. Tables that only grow are cut at that moment. Current-state tables are rebuilt from the change log, with an as_of_verified column. ${refusingAsOf.join(', ')} answer 400, and the data dictionary says why for each.`,
    },
  ],
}

/** Licensee keys, webhooks, the bulk feed, and the schema version (/data#institutions, /data#schema). */
const INSTITUTIONS: LlmsTxtSection = {
  heading: 'Bulk feed, API keys, webhooks, and schema versions',
  links: [
    {
      path: '/export/bulk/manifest.json',
      title: 'Bulk manifest',
      description:
        'One gzipped CSV per table, rebuilt once a day, and the same rows as Parquet (zstd, columns typed by the data dictionary) under parquet. Each entry has the file URL, rows, bytes, SHA-256, generated_at, schema_version, and license. Without a key it lists the trailing-window files (CC BY 4.0). Sync by comparing SHA-256s. The manifest and files answer If-None-Match with a 304, and the files answer Range requests, so DuckDB can read a Parquet URL in place.',
    },
    {
      path: '/data#institutions-s3',
      title: 'S3 access for licensees',
      description:
        'Licensees can also read the full-history files, CSV and Parquet, from an S3-compatible bucket (Cloudflare R2) with read-only credentials issued with their key. The bucket holds full/<table>.csv.gz, full/<table>.parquet, and manifest.json, and nothing else. Credentials end when the key does. Issued by email, never self-serve.',
    },
    {
      path: '/data#institutions',
      title: 'API keys for licensees',
      description: `Licensees send Authorization: Bearer <key>. A key raises the rate limit from ${REQUEST_BUDGETS.anonymous.read} requests a minute per IP to ${REQUEST_BUDGETS.research.read} (research) or ${REQUEST_BUDGETS.systematic.read} (systematic) per key, lists the full-history bulk files, and labels rows older than the window with the paid license instead of CC BY-NC 4.0. It never changes the data. A bad, expired, or revoked key gets a 401. Keys are issued by email, never self-serve.`,
    },
    {
      path: '/data#webhooks',
      title: 'Alert webhooks for licensees',
      description: `A licensee can get alerts POSTed to an https URL instead of polling, at or above a chosen severity (critical, notable, or info). The JSON body has schema_version, the alert with its permalink, source URLs and cited change rows, and the license for the key. ${WEBHOOK_HEADERS.signature} is sha256= and the hex HMAC-SHA256 of the raw body, keyed with a per-webhook secret. ${WEBHOOK_HEADERS.delivery} stays the same across retries, and ${WEBHOOK_HEADERS.timestamp} matches sent_at in the body. Deliveries are retried with backoff for ${WEBHOOK_RETRY_HOURS} hours, and never sent before the alert is on the public site. Set up by email, never self-serve.`,
    },
    {
      path: '/data#schema',
      title: `Schema version ${SCHEMA_VERSION}`,
      description: `Every export and /api JSON response states schema_version (a field, or the X-Schema-Version header on CSV and JSON arrays). Adding a column is a minor version. Removing or renaming one is a major version with ${BREAKING_NOTICE_DAYS} days’ notice to licensees. The changelog is under changelog in /export/dictionary.json.`,
    },
  ],
}
