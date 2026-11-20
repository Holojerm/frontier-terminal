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
// McpServer — twenty-two registrations, cheap — so a Worker isolate holds no
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

import {
  DATA_LICENSE,
  HISTORY_LICENSE,
  LICENSE_SPLIT_EFFECTIVE,
  LICENSE_WINDOW_DAYS,
} from '#shared/utils/license'
import { ALERT_AXES } from '../../shared/utils/terminal-labs'
import { LABS } from '../../shared/utils/terminal-lab-summary'
import { ALERT_TIER_FILTERS } from '../../shared/utils/terminal-tiers'

import type { PipelineDb } from '../pipeline/store'
import { collectStatus, type StatusConfig } from '#server/utils/fleet-status'
import { PointInTimeError, parseAsOfQuery, type AsOfPayload } from './terminal-asof'
import { HIRING_WINDOW_DAYS, queryHiring, queryHiringHistory } from './terminal-hiring'
import { INCIDENT_HISTORY_DAYS, INCIDENT_WINDOW_DAYS, queryIncidents } from './terminal-incidents'
import { MOVEMENT_WINDOW_HOURS, queryAlert, queryAlerts, queryOverview } from './terminal-alerts'
import { queryCoverage, recipeRunsStamp, type QueryContext } from './terminal-db'
import { queryPriceHistory, queryPrices, queryReleases } from './terminal-prices'
import { queryDependencies } from './terminal-dependencies'
import { queryDisclosures } from './terminal-disclosures'
import { gpuRunsStamp, queryGpuPrices } from './terminal-gpu'
import { probesStamp, queryProbes } from './terminal-probes'
import { SHARE_WINDOW_DAYS, queryRankings } from './terminal-rankings'
import { buildSuppliers, SUPPLIERS_VERSION } from './terminal-suppliers'
import { queryProspectus } from './terminal-prospectus'
import { queryExposure } from './terminal-exposure'
import { identifiersPayload } from './terminal-identifiers'
import { queryRevenue } from './terminal-revenue'
import { PROVIDER_ORDER } from './terminal-sources'
import { querySpend } from './terminal-spend'
import { queryTrackRecord } from './terminal-track-record'
import { queryGroundTruth } from './terminal-ground-truth'
import { reportedStamp } from './terminal-reported'
import { queryReliability, reliabilityStamp } from './terminal-reliability'
import type { RebuiltAsOf } from './terminal-handler'
import { repoSlug, workflowRunsUrl } from '../pipeline/reliability/deploys'
import { DETECTION_RULES, RELIABILITY_DAYS } from '../../shared/utils/terminal-reliability'
import manifest from '~~/fleet.json'

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

/** The JSON API's alert cap — how far back get_alerts searches and get_alert looks. */
export const ALERT_SEARCH_DEPTH = 500

const ProviderSchema = z
  .enum(PROVIDER_ORDER)
  .describe(
    'One of the nine tracked labs: openai, anthropic, google, xai, meta, mistral, deepseek, alibaba, moonshot.',
  )

// modelKey() output: `model:<provider>:<slug>[:<tier>]` (layers/terminal/server/pipeline/contracts/keys.ts) —
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

// Validated in the handler (parseAsOfQuery), not in the schema: a transform
// does not survive the conversion to the JSON Schema a client is shown.
const AsOfSchema = z
  .string()
  .optional()
  .describe(
    'Optional point in time, an ISO-8601 timestamp with a zone (e.g. 2026-10-01T12:00:00Z): the payload as the terminal ' +
      'knew it then, rebuilt from stored history, with point_in_time saying how (method) and which keys the change log ' +
      'cannot confirm (unverified). Omit for now.',
  )

/** A 400 from a point-in-time read (a bad or too-early as_of) is the caller's to fix: say it as a tool error. */
async function asOfErrors(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
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

const LICENSE =
  `license names the data license, split by age: our compilation and derived numbers from the last ${LICENSE_WINDOW_DAYS} days are ${DATA_LICENSE.short}, ` +
  `older ones ${HISTORY_LICENSE.short} (non-commercial use only), except what we published before ${LICENSE_SPLIT_EFFECTIVE}, which stays ${DATA_LICENSE.short}. ` +
  `A result with as_of older than ${LICENSE_WINDOW_DAYS} days is labeled ${HISTORY_LICENSE.id} in point_in_time.license. Upstream data keeps its own license.`

const PROVENANCE =
  'Every row carries source_url (the exact page it was read from) and fetched_at (UTC), the fetch that produced its current values; ' +
  'it only moves when they change. A current price row also carries checked_at, the newest read of that page that still showed it, or null. ' +
  'as_of is the newest poll the payload reflects. computed_at is when it was built: a payload is reused until new data arrives, so it can be older than your request. ' +
  LICENSE

const INSTRUCTIONS =
  `${MCP_SERVER_NAME}: a free, public, read-only investor terminal tracking the frontier AI labs ` +
  '(OpenAI, Anthropic, Google, xAI, Meta, Mistral, DeepSeek, Alibaba (Qwen), Moonshot AI (Kimi)) on seven axes — API price lists, hiring boards (with the physical-infrastructure buildout cluster), ' +
  'SEC filings and disclosed revenue, status-page incidents, misalignment disclosures, and OpenRouter demand share with its implied spend share. ' +
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

  /** A payload now, or as of `as_of` when the tool was given one. */
  const read = async <T extends object | null>(
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

  server.registerTool(
    'get_overview',
    {
      title: 'What moved',
      description:
        `The signal band. movement counts change rows by axis (pricing, hiring, sec) inside a ${MOVEMENT_WINDOW_HOURS}h window ` +
        'anchored to the NEWEST detection (window_from..latest_detected_at), not to the clock — so a quiet weekend still reports Friday’s moves. ' +
        'total_changes is the all-time denominator; sources_not_yet_compared counts sources with a single snapshot (nothing to diff yet). ' +
        'alerts are the newest notable/critical rows with their cited change rows and alert_count the total on file; info is the ' +
        'minor-changes tier (severity info: what moved, low stakes) and info_count its total. ' +
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
        'OpenAI prices come from its pricing.md (Standard / Batch / Flex / Fast tiers, long-context bands as their own tiers); its catalog page prints none. ' +
        'context_window_source is set when the window comes from another page than the row cites (Google prints windows on its model pages, not its pricing page). ' +
        'cross_check is OpenRouter: snapshotted as a drift check ' +
        'on the vendor pages, never a price of record. Optional provider filter narrows rows and matrix to one lab. ' +
        'reach says how far each lab’s price history goes back. An as_of before our first fetch is answered from the Internet Archive’s ' +
        'captures of each lab’s own pricing page (source_id wayback:<era>, point_in_time says which capture), with an empty matrix. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional(), as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ provider, as_of }) =>
      asOfErrors(async () => {
        const prices = await read(
          'prices',
          as_of,
          (ctx) => queryPrices(deps.db, ctx),
          '',
          'pricing',
        )
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
      }),
  )

  server.registerTool(
    'get_hiring',
    {
      title: 'Open roles',
      description:
        'Open roles per lab, counted from the CURRENT job-board set (a role missing from the board is closed), by department. ' +
        'feed says what the number is: ok, no_rows (feed registered, nothing parsed yet), or no_public_feed — Meta, DeepSeek, Alibaba and Moonshot AI, which ' +
        'have no public hiring feed we can read, so each total is 0 with the audit’s reason rather than a guess. Google counts DeepMind’s roles only ' +
        '(company_names says so), not Alphabet’s. xAI’s board is blended with SpaceX ' +
        '(every row carries company_name "SpaceXAI", now "SpaceXSI"); the caveat and company_names travel with the row so you can say so. ' +
        'as_of before our first read of the boards answers from the Internet Archive’s copies of each lab’s own board ' +
        '(source_id wayback:<era>, point_in_time names each copy; event time, not knowledge time). Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional(), as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ provider, as_of }) =>
      asOfErrors(async () => {
        const hiring = await read('hiring', as_of, (ctx) => queryHiring(deps.db, ctx), '', 'hiring')
        if (!provider) return json(hiring)
        return json({
          ...hiring,
          providers: hiring.providers.filter((p) => p.provider === provider),
        })
      }),
  )

  server.registerTool(
    'get_alerts',
    {
      title: 'Alerts and minor changes',
      description:
        'Alerts newest first, each citing the change rows it is a claim about (changes, resolved; missing_change_ids if any did not resolve). ' +
        'Severity reads as a tier: info is minor changes (what moved, low stakes — a role added, a title reworded); notable and critical are alerts ' +
        '(a price move, a new SKU, a department-level hiring shift, a filing). tier selects alert, critical or notable (that severity only), info, or all (default all); ticker is an old name for info. ' +
        'lab and topic keep alerts citing at least one change row from that lab or on that axis (pricing, hiring, sec, revenue, incidents, disclosures, demand). ' +
        'rule is s1-floor (deterministic: a registration statement appeared on EDGAR), periodic-floor (deterministic: a 10-Q/10-K on a ' +
        'whitelisted CIK), cik-resolved (deterministic: a pending lab’s own S-1 appeared and its CIK was read off it), model-floor (deterministic: a model slug no vendor catalog listed before), prospectus-floor (deterministic: what a lab’s new registration filing states — revenue and the price range on its cover), hiring-rollup (deterministic: one per lab per week, the board’s net change and the departments that moved most) or agent-judge (a model’s reading of change rows, labelled as such). total is the count on file for the chosen tier. ' +
        `With a severity filter, the newest ${ALERT_SEARCH_DEPTH} rows of the tier are searched and up to limit returned. ` +
        PROVENANCE,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(ALERT_SEARCH_DEPTH).default(20),
        tier: z.enum([...ALERT_TIER_FILTERS, 'ticker']).default('all'),
        severity: z.enum(['info', 'notable', 'critical']).optional(),
        lab: z.enum([...LABS, 'other']).optional(),
        topic: z.enum(ALERT_AXES).optional(),
        as_of: AsOfSchema,
      }),
      annotations: READ_ONLY,
    },
    ({ limit, tier: asked, severity, lab, topic, as_of }) =>
      asOfErrors(async () => {
        const tier = asked === 'ticker' ? 'info' : asked
        const depth = severity ? ALERT_SEARCH_DEPTH : limit
        const alerts = await read(
          'alerts',
          as_of,
          (ctx) => queryAlerts(deps.db, ctx, depth, tier, { lab, topic }),
          lab || topic ? `${tier}:${depth}:${lab ?? ''}:${topic ?? ''}:` : `${tier}:${depth}`,
        )
        if (!severity) return json(alerts)
        return json({
          ...alerts,
          rows: alerts.rows.filter((a) => a.severity === severity).slice(0, limit),
        })
      }),
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
        'an error, not an empty series. Points with kind archived (basis archived) come first: read from the Internet Archive’s capture ' +
        'of the lab’s own page before we watched it; at is the capture time, source_url the capture. archive_only=true when every point is archived. ' +
        PROVENANCE,
      inputSchema: z.object({ key: SkuKeySchema, as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ key, as_of }) =>
      asOfErrors(async () => {
        const history = await read(
          'price-history',
          as_of,
          (ctx) => queryPriceHistory(deps.db, ctx, key),
          key,
          'pricing',
        )
        if (history === null) {
          return failure(
            `No SKU with key ${key}${as_of ? ` as of ${as_of}` : ''}. Keys are listed by get_prices.`,
          )
        }
        return json(history)
      }),
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
        'rows the series rests on. clusters[] sums named department clusters from sources.yaml — physical-infrastructure (Data Center, ' +
        'Infrastructure, Facilities, Energy, Construction, Compute, Hardware; not Software) is the capacity-buildout signal — with the ' +
        'matched department labels listed so the sum is checkable. Meta, DeepSeek, Alibaba and Moonshot AI are audited cuts (feed ' +
        'no_public_feed, reason given) with empty series; xAI carries the SpaceXAI blend caveat. archived[] is the history from ' +
        'before the live series: the Internet Archive’s weekly copies of each lab’s own board (basis archived, source_id ' +
        'wayback:<era>, at = when the Archive saw it, fetched_at = when we read it), with the board total and clusters, CC BY-NC. ' +
        'Their departments are left out here: GET /api/hiring/history has them, and /export/archived_hiring.csv every row. ' +
        'reach says how far each lab’s history goes and every gap with its reason; archive_method says the rest. ' +
        'Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional(), as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ provider, as_of }) =>
      asOfErrors(async () => {
        const history = await read(
          'hiring-history',
          as_of,
          (ctx) => queryHiringHistory(deps.db, ctx),
          '',
          'hiring',
        )
        // An archived copy's departments would put a few hundred kB in a tool
        // result; the totals and clusters stay, the rest is one request away.
        const slim = {
          ...history,
          providers: history.providers.map((p) => ({
            ...p,
            archived: p.archived.map((a) => ({ ...a, departments: null })),
          })),
        }
        if (!provider) return json(slim)
        return json({
          ...slim,
          providers: slim.providers.filter((p) => p.provider === provider),
        })
      }),
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
        'Capacity strain as the vendor chose to post it: one status feed per lab that has one (OpenAI and Mistral Statuspage, ' +
        'Anthropic’s Atom history, xAI’s and DeepSeek’s RSS histories, Google Cloud ' +
        `filtered to Gemini / Vertex AI products). Per provider, incidents started in the newest ${INCIDENT_WINDOW_DAYS} days ` +
        '(last_window) against the same span before (prior_window), what is open now, and coverage_from — where held history ' +
        'begins; a Statuspage feed is a rolling window, so prior_window is partial until the pipeline has polled through it. ' +
        `incidents lists every one started inside ${INCIDENT_HISTORY_DAYS} days, newest first, with impact in the vendor’s own ` +
        'vocabulary (never mapped across vendors; null for Anthropic and DeepSeek, whose feeds publish none) and a link. Each lab’s window anchors on its own window_to, the last successful read of its status feed, not the ' +
        'clock, so a feed that stopped answering shows an earlier window_to rather than a quiet stretch. Not an SLA and not comparable across vendors: OpenAI’s feed mixes ChatGPT with API incidents and has no component ' +
        'field; xAI’s RSS history covers Cursor’s products alongside Grok and the API (read components). DeepSeek’s titles are Chinese with the English in parentheses. Meta, ' +
        'Alibaba and Moonshot AI have NO incident history we can read and are reported as no_public_feed with the reason, never as zero incidents. Optional provider filter narrows providers and incidents. ' +
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
    'get_disclosures',
    {
      title: 'Misalignment disclosures',
      description:
        'Each lab’s own index of misalignment reports and notices — agents leaving their sandbox, messaging each other through ' +
        'public services, deceiving in their own summaries. Only OpenAI publishes one (alignment.openai.com/misalignment-reports); ' +
        'every other lab is reported as no_public_feed with the audit’s reason, never as zero. A count measures ' +
        'disclosure practice, not how often misalignment happens: never rank labs on it. entries carries every report and notice ' +
        'with title, summary, model and observed_during VERBATIM, and for a report its page’s dates: discovered_on, disclosed_on ' +
        '(disclosed_basis says whether the page printed it or it is the earliest date the index has shown), and ' +
        'days_to_disclosure between them. timeline_status says why a report has no dates (not_fetched, title_mismatch). Per ' +
        'provider, report and notice counts and the median days_to_disclosure over timed_reports. Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const disclosures = await deps.serve('disclosures', (ctx) => queryDisclosures(deps.db, ctx))
      if (!provider) return json(disclosures)
      return json({
        ...disclosures,
        providers: disclosures.providers.filter((p) => p.provider === provider),
        entries: disclosures.entries.filter((e) => e.provider === provider),
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
    'get_revenue',
    {
      title: 'Disclosed revenue (primary source only)',
      description:
        'Revenue each lab, or the public parent that consolidates it, has reported to the SEC, read from EDGAR’s XBRL data. ' +
        'disclosure is none (no audited disclosure on file — nothing is shown, and press run-rates are deliberately absent), parent ' +
        '(a public parent’s figure, labelled as the parent’s: xAI via SpaceX/SPCX consolidated, whose XBRL carries no xAI segment; Google via Alphabet/GOOGL’s Google Cloud segment, filer.segment set, which is the segment’s revenue, not Gemini’s; Alibaba shows none: its parent reports in RMB and only annually in XBRL), ' +
        'issuer (the lab files for itself — tagged in sources.yaml, or resolved at poll time from its own S-1 by the pending_filers patterns, ' +
        'in which case filer.tagged_by is resolved and filer.resolved_from names the filing) or no_rows (tagged, nothing parsed yet). periods are the filer’s own USD values per ' +
        '(start, end) from the newest filing that reported them, each with the tag, form, accession and a link to the filing index; ' +
        'days distinguishes a quarter (~91) from a half (~182) or a year (~365) — nothing is derived across periods. superseded lists ' +
        'values a later filing restated. Never call a parent’s number the lab’s. Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional(), as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ provider, as_of }) =>
      asOfErrors(async () => {
        const revenue = await read('revenue', as_of, (ctx) => queryRevenue(deps.db, ctx))
        if (!provider) return json(revenue)
        return json({
          ...revenue,
          providers: revenue.providers.filter((p) => p.provider === provider),
        })
      }),
  )

  server.registerTool(
    'get_exposure',
    {
      title: 'Hyperscaler capex, backlog and lab stakes (filed XBRL)',
      description:
        'Quarterly series from 2020 built from the filed XBRL facts of Microsoft, Alphabet, Amazon, Meta and Oracle: capex (the cash line each tags, with finance leases ' +
        'beside it where the filer counts them, never added), remaining performance obligations (total, plus Microsoft commercial and Google Cloud where tagged), ' +
        'and every fact Microsoft tags on OpenAI (msft:OpenAIGlobalLlcMember) and Amazon on Anthropic (amzn:AnthropicMember). Each series names its concept and dims; ' +
        'points are oldest first, each from the newest filing that reported it, with accession, form, filing date and filing_url. derived marks a quarter computed as a ' +
        'year-to-date figure less the one a quarter shorter (less names it). superseded lists values a later filing restated. These are the filer’s numbers: ' +
        'Microsoft’s OpenAI line is what Microsoft recognized, not OpenAI’s result, and Amazon’s marks are not Anthropic’s valuation. gaps lists what the filings ' +
        'don’t tag (Alphabet never names Anthropic). as_of keeps the facts filed before that UTC day, back to 2020. Optional group (capex, rpo, openai, anthropic) ' +
        'and ticker filters. ' +
        PROVENANCE,
      inputSchema: z.object({
        group: z.enum(['capex', 'rpo', 'openai', 'anthropic']).optional(),
        ticker: z.enum(['MSFT', 'GOOGL', 'AMZN', 'META', 'ORCL']).optional(),
        as_of: AsOfSchema,
      }),
      annotations: READ_ONLY,
    },
    ({ group, ticker, as_of }) =>
      asOfErrors(async () => {
        const exposure = await read(
          'exposure',
          as_of,
          (ctx) => queryExposure(deps.db, ctx),
          '',
          'filed',
        )
        return json({
          ...exposure,
          series: exposure.series.filter(
            (s) => (!group || s.group === group) && (!ticker || s.ticker === ticker),
          ),
          gaps: exposure.gaps.filter(
            (g) => (!group || g.group === group) && (!ticker || g.ticker === ticker),
          ),
        })
      }),
  )

  server.registerTool(
    'get_dependencies',
    {
      title: 'Dependency graph: who buys from and funds whom (filed)',
      description:
        'The labs and the public companies around them as a graph, from SEC filings only. nodes are companies: the five filers whose XBRL we read (Microsoft, Amazon, Alphabet, Meta, Oracle), ' +
        'each lab a filing names, and any other named counterparty (kind venture). A node carries two sizes from its own filing, each null where none is filed: contracts (a filer’s remaining ' +
        'performance obligations, which customers owe it; a lab’s aggregate contractual obligations from its prospectus, which it owes suppliers) and capex (the newest quarter). ' +
        'edges are directed. kind buys runs from the customer to the supplier (backlog, revenue, receivables the filer tags on the customer); kind funds runs from the investor to the lab ' +
        '(funding commitments, credit lines, stakes, marks). reporter is the node whose filing states every figure on the edge, so a figure is the filer’s number, never the lab’s. ' +
        'facts lists every figure with its label, value, unit, period, form, filing date and filing_url; weight is the first dollar figure, which the page uses for line width. ' +
        'Edges carry different kinds of figure (a backlog balance, an amount added in one quarter, a funding commitment), so do not sum weights. gaps lists what no filing gives: a lab with ' +
        'no filing of its own, obligations with no named supplier, filers and labs with no edge, and suppliers we don’t read (chips, power). unplaced lists figures tagged on a lab that are ' +
        'not on an edge. No press-reported deal is included. No as_of: use get_exposure for point-in-time series. Optional node filter keeps the edges touching one node id. ' +
        PROVENANCE,
      inputSchema: z.object({
        node: z
          .string()
          .max(40)
          .optional()
          .describe(
            'A node id: a lab id (openai, anthropic) or a ticker (MSFT, AMZN, GOOGL, META, ORCL).',
          ),
      }),
      annotations: READ_ONLY,
    },
    async ({ node }) => {
      const data = await deps.serve('dependencies', (ctx) => queryDependencies(deps.db, ctx))
      if (!node) return json(data)
      const edges = data.edges.filter((e) => e.from === node || e.to === node)
      const ids = new Set([node, ...edges.flatMap((e) => [e.from, e.to])])
      return json({ ...data, edges, nodes: data.nodes.filter((n) => ids.has(n.id)) })
    },
  )

  server.registerTool(
    'get_suppliers',
    {
      title:
        'Suppliers: chip, hardware and compute-rental companies tied to a lab or cloud (filed)',
      description:
        'The listed chip, foundry, networking, optics, server, compute-rental and data-center hosting companies whose own SEC filings tie them to a lab or a cloud. ' +
        'rows is one filed passage each: ticker, company, layer, relation (customer: the counterparty buys from the company; supplier: the company buys from it; ' +
        'investment: the company invests in it; investor: it holds a stake or warrant in the company; guarantee: the company guarantees its obligations; concentration: a customer the filing gives a share for and does not name), ' +
        'counterparty (the name, or for concentration the filing’s own label such as Customer A), counterparty_ticker, counterparty_lab, figures (value, unit, meaning; ' +
        'units usd, pct_revenue, pct_receivables, pct_backlog, shares, gw), form, filed, period, source_url, quote and fetched_at (when the quote was last found in the document). ' +
        'companies is one row per ticker: the counterparties its filings name, the tracked labs among them, top_named_share and top_unnamed_share (the largest share of its revenue ' +
        'a filing puts on one customer, named or not). A concentration row is tied to no lab or cloud: never infer who the customer is. Shares are for each company’s own fiscal period, ' +
        'and figures measure different things, so do not sum them. The table is read by hand and is not a complete list of suppliers; gaps says what is left out. ' +
        'Not investment advice. Optional ticker keeps one company; optional counterparty keeps rows naming a lab id or a counterparty ticker. ' +
        PROVENANCE,
      inputSchema: z.object({
        ticker: z
          .string()
          .max(8)
          .optional()
          .describe('A supplier ticker, such as NVDA, AMD, ANET or CRWV.'),
        counterparty: z
          .string()
          .max(40)
          .optional()
          .describe(
            'A lab id (openai, anthropic, xai) or a counterparty ticker (MSFT, META, NVDA).',
          ),
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, counterparty }) => {
      const data = await deps.serve('suppliers', async () => buildSuppliers(), SUPPLIERS_VERSION)
      if (!ticker && !counterparty) return json(data)
      const rows = data.rows.filter(
        (r) =>
          (!ticker || r.ticker === ticker.toUpperCase()) &&
          (!counterparty ||
            r.counterparty_lab === counterparty.toLowerCase() ||
            r.counterparty_ticker === counterparty.toUpperCase()),
      )
      const kept = new Set(rows.map((r) => r.ticker))
      return json({ ...data, rows, companies: data.companies.filter((c) => kept.has(c.ticker)) })
    },
  )

  server.registerTool(
    'get_track_record',
    {
      title: 'Track record: did we see it before the press?',
      description:
        'For each notable or critical alert since 2026-09-08: saw_at (when the terminal saw the change: the fetch of the earliest cited ' +
        'change row, or for a removal the run that noticed it), and two sides, press (the first article GDELT indexed) and newsroom ' +
        '(the first post on the lab’s own newsroom feed; Anthropic and xAI publish none). A side has a time only when its state is matched: ' +
        'the judge rated that candidate the same event and every earlier candidate not. lead_hours is that time minus saw_at, ' +
        'positive when the terminal saw it first. Other states say why there is no time: window-open (searched once 7 days have passed), ' +
        'not-searched, not-searchable, no-feed, none-found, not-yet-rated (never a guessed lead), no-match. ' +
        'press.published_at is the quarter hour GDELT’s crawler read the article, not when the outlet published it, and GDELT misses outlets. ' +
        'A lead is not a trading signal. press and newsroom tally led, lagged, tied and the median lead over matched rows. ' +
        'A press side with searched_from set was searched only from that time: earlier press was read before the alert existed and never matched to it, ' +
        'so its lead may not be one, and the tally leaves it out (searched_in_part counts them). ' +
        PROVENANCE,
      inputSchema: z.object({ as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ as_of }) =>
      asOfErrors(async () =>
        json(await read('track-record', as_of, (ctx) => queryTrackRecord(deps.db, ctx))),
      ),
  )

  server.registerTool(
    'get_ground_truth',
    {
      title: 'Ground truth: press reports and capex guidance against the filing that came later',
      description:
        'For a lab that files for itself (Anthropic so far): each press headline that stated its revenue before a filing printed that figure, ' +
        'grouped under the filed figure. resolutions[] has the filed value, the first filing that printed it (first_filed, form, filing_url), ' +
        'the reports scored against it earliest first, the median report, error_pct ((reported − filed) / filed), and lead_days from the earliest report to the filing day. ' +
        'A report is scored only against a figure not yet filed when it was published. matched_by says how the period was chosen: stated (the headline names the year or quarter) ' +
        'or nearest (the closest not-yet-filed figure within tolerance_pct, since most headlines name no year). ' +
        'A filed figure with derived_from is one filed period minus another with the same start (a quarter no filing prints). ' +
        'States: matched, missed (a named period more than tolerance_pct off), restated (published on or after the filing day, not scored), open (nothing filed to check it against). ' +
        'held_before_filing is false for a headline we read back from GDELT’s archive after the filing: the press had it first and our store did not. ' +
        'waiting[] lists reported figures no filing can score: a lab that hasn’t filed (no-filing), or run-rates, valuations and funding (not-in-filings). ' +
        'deals.reports[] checks press reports of a deal’s size (metric commitment, investment, financing or commitment_total, with the counterparty as the headline names it) ' +
        'against the figure the other company filed. deals.measures[] lists each filed figure used and how: added (the amount added to a backlog in the quarter the report was published), ' +
        'total (the first balance dated on or after the report), or null with why (a backlog balance isn’t a contract’s headline value). ' +
        'A deal report is unsettled, with reason and why, when we read no filings from the counterparty (no-filer), its filings state no figure for it (not-filed), or they state a different measure (different-measure). Unsettled reports are never scored. ' +
        'guidance.rows[] has each capex figure an earnings release (8-K exhibit 99.1) printed for a fiscal year: low and high in USD, the release’s sentence, and actual, the capex the 10-K later filed for that year with the filed lines it sums. ' +
        'States: met (inside the range, or within tolerance_pct of a single figure), above, below, open (the year isn’t filed), unsettled (we don’t read the line the filer guides). error_pct is the distance outside the range. ' +
        'guidance.filers[] says how many releases each filer has and how many print a figure: Meta, Alphabet and Oracle are scored, Amazon is listed and not scored, and Microsoft prints none (guidance given only on the call is not read). ' +
        'alerts has the totals of get_track_record. Headlines come from GDELT, which misses Bloomberg, Reuters, the WSJ and the FT. Not investment advice. ' +
        PROVENANCE,
      inputSchema: z.object({ as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ as_of }) =>
      asOfErrors(async () =>
        json(
          await read(
            'ground-truth',
            as_of,
            (ctx) => queryGroundTruth(deps.db, ctx),
            await reportedStamp(deps.db),
          ),
        ),
      ),
  )

  server.registerTool(
    'get_prospectus',
    {
      title: 'What a lab’s own S-1 prints beyond revenue',
      description:
        'For each lab that has filed its own registration statement (today Anthropic’s S-1 and S-1/A), what the document prints, read as printed: ' +
        'statement.periods and statement.lines are the whole statement of operations — every line verbatim with a canonical key where known ' +
        '(revenue, total_operating_expenses, operating_income, net_income, eps_basic_diluted, weighted_shares_basic_diluted) — in dollars, shares or dollars per share, ' +
        'each period from the newest filing that reports it (statement.superseded keeps the earlier filing’s figures); interim periods are unaudited. ' +
        'statement.not_printed names lines an analyst may look for that the statement does not print (Anthropic prints no cost of revenue or gross profit, ' +
        'so there is no gross margin — do not derive one). commitments are the contractual-obligation and purchase-commitment schedules with their as-of date ' +
        'and year buckets; approximate marks a figure the filing itself calls approximate, and statement quotes the sentence. concentration lists customers ' +
        'at or above 10% of revenue or receivables, named as the filing names them; a null share is under 10%, not zero. shares are “The Offering” counts, null ' +
        'while the filing leaves them blank. risk_factors.latest is every heading in the newest filing; risk_factors.diffs is each amendment against the filing ' +
        'before it — added, removed, or reworded with the earlier words. Nothing is estimated. Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const data = await deps.serve('prospectus', (ctx) => queryProspectus(deps.db, ctx))
      if (!provider) return json(data)
      return json({ ...data, issuers: data.issuers.filter((i) => i.provider === provider) })
    },
  )

  server.registerTool(
    'get_spend',
    {
      title: 'Implied spend share (OpenRouter channel)',
      description:
        `The ${SHARE_WINDOW_DAYS}-day rankings joined to the vendors’ list prices: per lab, tokens routed, the share of those tokens that ` +
        'matched a priced SKU (coverage), and implied spend as a RANGE — spend_low is every token at the input list price, spend_high ' +
        'every token at the output price (the rankings carry no prompt/completion split, so a point estimate would be invented). ' +
        'share_low/share_high are each lab’s slice of the tracked labs’ implied dollars at each bound; token_share is the same window’s ' +
        'slice of the tracked labs’ tokens (NOT of all OpenRouter tokens, which get_rankings reports); priced_token_share is the lab’s slice of the priced tokens only, the same universe as the dollar shares, so compare dollars with priced_token_share. models[] shows the join per model, with reason (free, unlisted, ' +
        'unpriced) for every model excluded from dollars. This is one aggregator’s channel at list price, not revenue and not market ' +
        'share; cite it as implied OpenRouter-channel spend and reproduce the CC BY 4.0 citation in rankings.meta.citation. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () => json(await deps.serve('spend', (ctx) => querySpend(deps.db, ctx))),
  )

  server.registerTool(
    'get_coverage',
    {
      title: 'Source coverage',
      description:
        'Every registered source: its audited URL, role (primary, join, cross-check, sec), the audit’s caveat in its own words, ' +
        'newest snapshot (with HTTP status and byte count), how the last poll ended (ok, unchanged, failed, baseline), snapshot count ' +
        'and how many current rows came from it. recipes lists the thesis recipes (GPU rental prices, filers outside the labs), which store ' +
        'outside the lab tables: each one’s last run, observation count, newest stored fetch, and its audit caveat and terms. ' +
        'cuts lists what is deliberately NOT tracked and why. totals are table row counts; ' +
        'exports describes the CSV/JSON bulk downloads at /export/<table>.csv|json; history says whether a table downloads whole or, by default, ' +
        `only its last ${LICENSE_WINDOW_DAYS} days (add ?history=full for every row, labeled per row with its license). Each column’s type, unit, nullability, ` +
        'meaning and license-window date are in the data dictionary at /export/dictionary.json, with the schema_version and its changelog. ' +
        'Every table is also a daily gzipped CSV and Parquet file listed, with SHA-256s, in /export/bulk/manifest.json. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () =>
      json(
        await deps.serve(
          'coverage',
          (ctx) => queryCoverage(deps.db, ctx),
          await recipeRunsStamp(deps.db),
        ),
      ),
  )

  server.registerTool(
    'get_identifiers',
    {
      title: 'Security-master identifiers',
      description:
        'identifiers: one row per company the site names (each lab, each SEC filer we read, each comparison company) with its legal name, ' +
        'country, listing status (listed, registered, subsidiary, private), CIK, LEI and, when listed, ticker, MIC and US composite FIGI. ' +
        'Each identifier has its own _source_url and _fetched_at, and a null LEI has its reason in lei_note. entity_id is the value of every ' +
        'provider and company field in the other tools, so join on it. securities: which listed security carries each lab (self, a parent ' +
        'that consolidates it, or an investor that discloses a stake) with disclosed_in, the filing that says so. A stake is never inferred ' +
        'from press. Optional entity filter. ' +
        PROVENANCE,
      inputSchema: z.object({
        entity: z
          .string()
          .regex(/^[a-z][a-z-]{0,39}$/)
          .optional()
          .describe('An entity_id, e.g. anthropic, alphabet, microsoft.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ entity }) =>
      json(await deps.serve('identifiers', async () => identifiersPayload(entity), entity ?? '')),
  )

  server.registerTool(
    'get_reliability',
    {
      title: 'Reliability: how the feed itself has performed',
      description:
        `For due diligence on the feed, computed from stored records. sources: each registered source (derived per-model and per-filing sources folded by template, members > 0) with runs and good runs over the last ${RELIABILITY_DAYS.short} (short) and ${RELIABILITY_DAYS.long} (long) UTC days, ` +
        'where good is ok, unchanged, baseline or absent (an answered check) and skipped runs are not counted; longest_gap is the longest wait between good runs (to null while still open); stated_minutes is how often we say we check it. Worst first. ' +
        'freshness: per lane (sec: SEC feeds, model catalogs and price lists, stated every 30 minutes; all: every source, stated every 6 hours), the periods our data was past its stated age, from the poll ticks in which most sources answered. ' +
        `detection: each filing a no-model rule alerted on (${DETECTION_RULES.join(', ')}), its first alert time against EDGAR's acceptance time (accepted_at, read from the stored submissions JSON or filing index; null when no stored payload listed it), ` +
        'and released_at, when EDGAR made it public (6:00 a.m. Eastern on the filing date for a filing accepted after 5:30 p.m. Eastern). Median and worst minutes for both. ' +
        'deploys: each run of the post-deploy smoke test on main from GitHub Actions (conclusion success, failure, or cancelled when a newer push superseded it), with build_sha the commit now deployed. ' +
        'corrections: the count and newest entry of the public corrections log. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () => {
      const slug = repoSlug(manifest.links.github ?? '')
      const opts = {
        buildSha: deps.status.buildSha || null,
        repoUrl: manifest.links.github ?? '',
        runsUrl: slug ? workflowRunsUrl(slug) : '',
      }
      return json(
        await deps.serve(
          'reliability',
          (ctx) => queryReliability(deps.db, ctx, opts),
          await reliabilityStamp(deps.db),
        ),
      )
    },
  )

  server.registerTool(
    'get_probes',
    {
      title: 'Latency probes: measured strain per lab',
      description:
        'Our own measurement, not a vendor’s page. Once an hour we send each lab’s flagship model one fixed streaming request (probe.prompt, capped at probe.max_tokens) ' +
        'through OpenRouter, pinned to the lab’s own endpoint with no fallback, and time the reply. labs has one entry per tracked lab. status probed carries latest (the newest probe: outcome, http_status, ' +
        'ttft_ms, total_ms, output_tokens, tokens_per_second, ran_from as cloudflare:<colo>), window (the trailing window_days of complete days) and days (one reading per UTC day, newest first, history_days back). ' +
        'A day gives probes, ok, rate_limited, failed, strained_share ((rate_limited + failed) ÷ probes), peak_tps and offpeak_tps (median tokens per second in the lab’s fixed UTC peak and off-peak hours, named in hours; ' +
        'null under three good probes) and peak_to_offpeak (under 1 means slower in working hours). complete is false for the current UTC day. Probes refused because of our key, credit or the router are left out of probes. ' +
        'status not_probed is a lab with no first-party endpoint to probe, with the reason in gap, never a zero. status waiting is a target with no probe stored yet. since is the first day probed: history starts there and cannot be backfilled. ' +
        'This is a strain reading, not utilization, and it is unproven as a predictor. Hourly sampling misses short rate-limit bursts. Compare a lab with its own history, not across labs: five of the models cannot turn reasoning off, ' +
        'so their first token waits on it. Read method and caveat before quoting a number. Optional provider filter narrows labs. No as_of: read the day you want from days. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const probes = await deps.serve(
        'probes',
        (ctx) => queryProbes(deps.db, ctx),
        await probesStamp(deps.db),
      )
      if (!provider) return json(probes)
      return json({ ...probes, labs: probes.labs.filter((l) => l.lab === provider) })
    },
  )

  server.registerTool(
    'get_gpu_prices',
    {
      title: 'GPU rental prices',
      description:
        'On-demand H100 and B200 rental prices from first-party price pages and documented price APIs (Lambda, CoreWeave, Nebius, ' +
        'Crusoe, Together AI, DigitalOcean, Verda, Azure, Oracle), normalized to usd_per_gpu_hour: an instance price divided by its GPUs, ' +
        'with gpus_per_instance, instance_usd_per_hour, region and config kept as printed. medians counts each provider once, at the ' +
        'median of its own counted rows; PCIe and NVL cards have counted=false. failed names providers whose page failed today; they are ' +
        'left out, never carried forward. These are list prices, not transaction prices (see caveat). The Compute thesis divides the ' +
        'flagship token price by the H100 median. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () =>
      json(
        await deps.serve(
          'gpu-prices',
          (ctx) => queryGpuPrices(deps.db, ctx),
          await gpuRunsStamp(deps.db),
        ),
      ),
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
