// Read-only query layer over the pipeline tables — what every terminal page
// renders. The UI never writes: layers/terminal/server/pipeline/store.ts › insertRows() is
// the only write path.
//
// Drizzle/D1 queries over those tables, shaped by one structural fact the
// store forces: `entities` here IS the current set
// (one row per source and key, rewritten in place, deleted on removal), so
// "the newest revision per SKU" is the entity row and the previous revision
// is the newest `changes` row for that key. Jobs are a set — a role missing
// from the board is closed — so open roles are counted straight from
// `entities`. Prices are a series, so a delisted SKU stays visible, struck
// through, from its removal change.
//
// Every function takes the Drizzle client explicitly (the shape
// server/utils/fleet-status.ts uses) so layers/terminal/test/terminal-db.test.ts drives them
// against the workerd D1.

import { and, asc, count, desc, eq, inArray, max, min, ne, sql } from 'drizzle-orm'

import { count as countLabel, money } from '../../shared/utils/terminal-format'
import {
  alertTier,
  severitiesOf,
  type AlertSeverity,
  type AlertTierFilter,
} from '../../shared/utils/terminal-tiers'
import type {
  AlertDetailData,
  AlertView,
  AlertsData,
  LabId,
  ChangeDetailView,
  ChangeView,
  CoverageData,
  RecipeCoverage,
  DeptCount,
  HiringData,
  HiringHistoryData,
  HiringHistoryProvider,
  HiringProviderView,
  HiringSource,
  IncidentProviderView,
  IncidentView,
  IncidentsData,
  MatrixCell,
  MovementSummary,
  OverviewData,
  PriceDeltaView,
  PriceHistoryData,
  PriceMatrix,
  PriceRowView,
  PricesData,
  ProviderId,
  ReleasesData,
  SnapshotStamp,
  SourceCoverage,
  SourceRef,
  SourceRunStamp,
  Stamp,
  TableCounts,
} from '../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import { manifestFixtures } from '../pipeline/parsers/fixture-provenance'
import { parseDerivedSourcesBlock, type DerivedTemplate } from '../pipeline/derived'
import { parseRevenueFilersBlock, type RevenueFilers } from '../pipeline/parsers/sec/revenue-filers'
import { parseCikWhitelistBlock, type CikWhitelist } from '../pipeline/parsers/sec/whitelist'
import { effectiveClassMap } from '../pipeline/class-map'
import { RECIPES } from '../theses/recipes/registry'
import type { PipelineDb } from '../pipeline/store'
import type { DataFreshness } from '#server/utils/seo'
import {
  BASIS_STALE_NOTE,
  CLASS_GAPS,
  MODEL_CLASSES,
  MODEL_CLASS_MAP,
  NO_ROW_GAP,
  PRICE_GAPS,
  type ClassEntry,
} from './terminal-classes'
import { clusterSeries, parseDepartmentClusters, type DepartmentCluster } from './terminal-clusters'
import { EXPORT_TABLES } from './terminal-export'
import {
  ALERTS_METHOD,
  ENTITY_METHOD,
  alertsKnownAt,
  judgeCutoffAt,
  pointInTimeNotes,
  rewindEntities,
  type PointInTimeNotes,
  type Rewound,
} from './terminal-asof'
import {
  baselineInstants,
  byDetectedAt,
  compareWindow,
  dailyInstants,
  dayOf,
  departmentSeries,
  NO_DEPARTMENT,
  openRolesAt,
  priceHistory,
  releaseEvents,
  sparkOf,
  type OpenRole,
} from './terminal-history'
import { byString, fieldDiff, fieldTable, num, parseJson, str, type Json } from './terminal-json'
import {
  HIRING_SOURCES,
  INCIDENT_SOURCES,
  PROVIDER_DISPLAY,
  PROVIDER_ORDER,
  DERIVED_TERMS_FROM,
  derivedTemplateOf,
  labelOf,
  readSourceRegistry,
  type SourceRegistry,
} from './terminal-sources'

/** What every query needs beyond the client: the registry and the tick it reports. */
export interface QueryContext {
  registry: SourceRegistry
  /** sources.yaml department_clusters — the buildout signal's department terms. */
  clusters: DepartmentCluster[]
  /** sources.yaml revenue_filers and cik_whitelist — which lab a filer's facts belong to. */
  revenueFilers: RevenueFilers
  whitelist: CikWhitelist
  /** sources.yaml derived_sources — the templates, for naming derived sources on the coverage panel. */
  derivedTemplates: DerivedTemplate[]
  /** Newest source_runs.started_at, already read for the cache key — at or before `at` when one is set. */
  as_of: string | null
  now: () => Date
  /**
   * The instant a point-in-time request (`?as_of=`) asks about, or null for
   * now. A query that honours it must read every table as of that instant
   * (layers/terminal/server/utils/terminal-asof.ts); a route whose query
   * does not is refused before it runs (terminal-handler.ts › serveTerminal).
   */
  at: string | null
  /** How a point-in-time payload was rebuilt; terminalPayload attaches it. */
  notes: PointInTimeNotes
}

export function queryContext(
  sourcesYaml: string,
  as_of: string | null,
  now: () => Date = () => new Date(),
  at: string | null = null,
): QueryContext {
  return {
    registry: readSourceRegistry(sourcesYaml),
    clusters: parseDepartmentClusters(sourcesYaml),
    revenueFilers: parseRevenueFilersBlock(sourcesYaml),
    whitelist: parseCikWhitelistBlock(sourcesYaml),
    derivedTemplates: parseDerivedSourcesBlock(sourcesYaml),
    as_of,
    now,
    at,
    notes: pointInTimeNotes(),
  }
}

/** The entity set of `type` (or one key) at ctx.at, noted on the payload's point_in_time. */
export async function rewound(
  db: PipelineDb,
  ctx: QueryContext & { at: string },
  type: string,
  key?: string,
): Promise<Rewound> {
  const r = await rewindEntities(db, type, ctx.at, key)
  ctx.notes.method.add(ENTITY_METHOD)
  for (const k of r.unverified) ctx.notes.unverified.add(k)
  return r
}

const atOf = (ctx: QueryContext): (QueryContext & { at: string }) | null =>
  ctx.at === null ? null : (ctx as QueryContext & { at: string })

/** The audit's reason for a sources.yaml cut, or null when the id is not registered. */
const cutReason = (ctx: QueryContext, cutId: string): string | null =>
  ctx.registry.cuts.find((c) => c.id === cutId)?.reason ?? null

const stampOf = (ctx: QueryContext): Stamp => ({
  as_of: ctx.as_of,
  computed_at: ctx.now().toISOString(),
})

const PROVIDER_RANK: Readonly<Record<string, number>> = {
  openai: 0,
  anthropic: 1,
  google: 2,
  xai: 3,
  meta: 4,
  mistral: 5,
  other: 6,
}

// ---- snapshots and runs ------------------------------------------------------

export interface SourceStamp {
  source_id: string
  newest: SnapshotStamp
  /** Null in a point-in-time read: counting snapshots up to T reads every one of them. */
  snapshot_count: number | null
}

/**
 * Newest snapshot per source, with how many that source has. Read through
 * source_stats: one index seek per source instead of a scan of every
 * snapshot. CROSS JOIN, here and in the two queries like it below, is
 * SQLite's way of fixing the loop order — given a plain join, the planner
 * walks the big table and probes source_stats, which reads every row again.
 */
export async function sourceStamps(
  db: PipelineDb,
  at: string | null = null,
): Promise<Map<string, SourceStamp>> {
  // As of T, the newest snapshot at or before it: one index seek per source
  // on (source_id, fetched_at), as the subquery is correlated to the outer row.
  const newestAt = at
    ? sql`(select s.fetched_at from snapshots s where s.source_id = ${tables.sourceStats.source_id} and s.fetched_at <= ${at} order by s.fetched_at desc limit 1)`
    : tables.sourceStats.last_fetched_at
  const rows = await db
    .select({
      source_id: tables.snapshots.source_id,
      source_url: tables.snapshots.source_url,
      fetched_at: tables.snapshots.fetched_at,
      http_status: tables.snapshots.http_status,
      bytes: tables.snapshots.bytes,
      n: tables.sourceStats.snapshot_count,
    })
    .from(tables.sourceStats)
    .crossJoin(tables.snapshots)
    .where(
      and(
        eq(tables.snapshots.source_id, tables.sourceStats.source_id),
        eq(tables.snapshots.fetched_at, newestAt),
      ),
    )
    .orderBy(asc(tables.snapshots.source_id), desc(tables.snapshots.id))

  const out = new Map<string, SourceStamp>()
  for (const row of rows) {
    if (out.has(row.source_id)) continue // two fetches in the same instant: first wins
    out.set(row.source_id, {
      source_id: row.source_id,
      newest: {
        source_url: row.source_url,
        fetched_at: row.fetched_at,
        http_status: row.http_status,
        bytes: row.bytes,
      },
      snapshot_count: at ? null : row.n,
    })
  }
  return out
}

/** First snapshot per source — when watching it began. */
async function firstSnapshotPerSource(
  db: PipelineDb,
): Promise<{ source_id: string; source_url: string; fetched_at: string }[]> {
  return db
    .selectDistinct({
      source_id: tables.snapshots.source_id,
      source_url: tables.snapshots.source_url,
      fetched_at: tables.snapshots.fetched_at,
    })
    .from(tables.sourceStats)
    .crossJoin(tables.snapshots)
    .where(
      and(
        eq(tables.snapshots.source_id, tables.sourceStats.source_id),
        eq(tables.snapshots.fetched_at, tables.sourceStats.first_fetched_at),
      ),
    )
}

/** Newest run per source — how the last poll of it ended. */
export async function lastRuns(db: PipelineDb): Promise<Map<string, SourceRunStamp>> {
  const rows = await db
    .select({
      source_id: tables.sourceRuns.source_id,
      started_at: tables.sourceRuns.started_at,
      status: tables.sourceRuns.status,
      detail: tables.sourceRuns.detail,
      scope: tables.sourceRuns.scope,
      source_url: tables.sourceRuns.source_url,
    })
    .from(tables.sourceStats)
    .crossJoin(tables.sourceRuns)
    .where(
      and(
        eq(tables.sourceRuns.source_id, tables.sourceStats.source_id),
        eq(tables.sourceRuns.started_at, tables.sourceStats.last_run_at),
      ),
    )
    .orderBy(asc(tables.sourceRuns.source_id), desc(tables.sourceRuns.id))

  const out = new Map<string, SourceRunStamp>()
  for (const row of rows) {
    if (out.has(row.source_id)) continue
    out.set(row.source_id, {
      started_at: row.started_at,
      status: row.status as SourceRunStamp['status'],
      detail: row.detail,
      scope: row.scope,
      source_url: row.source_url,
    })
  }
  return out
}

export async function tableCounts(db: PipelineDb): Promise<TableCounts> {
  const total = async (
    table: typeof tables.entities | typeof tables.changes | typeof tables.alerts,
  ) => {
    const [row] = await db.select({ total: count() }).from(table)
    return row?.total ?? 0
  }
  // snapshots and source_runs from source_stats: count(*) reads every row.
  const [logged] = await db
    .select({
      snapshots: sql<number>`coalesce(sum(${tables.sourceStats.snapshot_count}), 0)`,
      source_runs: sql<number>`coalesce(sum(${tables.sourceStats.run_count}), 0)`,
    })
    .from(tables.sourceStats)
  return {
    snapshots: logged?.snapshots ?? 0,
    entities: await total(tables.entities),
    changes: await total(tables.changes),
    alerts: await total(tables.alerts),
    source_runs: logged?.source_runs ?? 0,
  }
}

// ---- movement (the signal band) ---------------------------------------------

export const MOVEMENT_WINDOW_HOURS = 24

export const AXIS_OF: Readonly<Record<string, keyof Omit<MovementSummary['recent'], 'total'>>> = {
  model: 'pricing',
  recommendation: 'pricing',
  job: 'hiring',
  filing: 'sec',
  revenue: 'sec',
  filer: 'sec',
  document: 'sec',
  incident: 'incidents',
  disclosure: 'disclosures',
  disclosure_timeline: 'disclosures',
}

// Ranking rows are a daily time series, not events (~50 new rows a day by
// construction), so they are out of "what moved" entirely — the window's
// anchor included, or a ranking tick would pull the 24h window past a price
// change detected the day before. Same exclusion as the judge's pending
// query (layers/terminal/server/pipeline/judge/pending.ts › JUDGE_EXCLUDED_ENTITY_TYPES).
const isEvent = () => ne(tables.changes.entity_type, 'ranking')

/**
 * Reported window: 24h back from the NEWEST detection, not from the reader's
 * clock. A terminal opened on Monday must still say what moved on Friday
 * rather than "nothing recently" — and the window's start ships with the
 * number so the claim is checkable. window_from is derived from the same
 * max() the counts filter on — deriving it per entity type instead reports a
 * window the counts were never filtered on.
 */
export async function queryMovement(db: PipelineDb): Promise<MovementSummary> {
  const [bounds] = await db
    .select({ latest: max(tables.changes.detected_at), n: count() })
    .from(tables.changes)
    .where(isEvent())
  const totalChanges = bounds?.n ?? 0
  const latest = bounds?.latest ?? null

  const recent = { pricing: 0, hiring: 0, sec: 0, incidents: 0, disclosures: 0, total: 0 }
  let windowFrom: string | null = null
  if (latest !== null && totalChanges > 0) {
    windowFrom = new Date(Date.parse(latest) - MOVEMENT_WINDOW_HOURS * 3_600_000).toISOString()
    // datetime() on both sides: stored stamps may carry milliseconds or not,
    // and a plain string compare between the two spellings is only right by
    // accident.
    const inWindow = await db
      .select({ entity_type: tables.changes.entity_type, n: count() })
      .from(tables.changes)
      .where(
        and(isEvent(), sql`datetime(${tables.changes.detected_at}) >= datetime(${windowFrom})`),
      )
      .groupBy(tables.changes.entity_type)
    for (const row of inWindow) {
      const axis = AXIS_OF[row.entity_type]
      if (axis) recent[axis] += row.n
      recent.total += row.n
    }
  }

  const perSource = await db
    .select({ n: tables.sourceStats.snapshot_count })
    .from(tables.sourceStats)
    .where(sql`${tables.sourceStats.snapshot_count} > 0`)

  return {
    latest_detected_at: latest,
    window_from: windowFrom,
    window_hours: MOVEMENT_WINDOW_HOURS,
    recent,
    total_changes: totalChanges,
    sources_total: perSource.length,
    sources_not_yet_compared: perSource.filter((s) => s.n === 1).length,
  }
}

// ---- alerts ----------------------------------------------------------------

function summarize(entityType: string, payload: Json | null): string {
  if (!payload) return '(payload unreadable)'
  if (entityType === 'model') {
    const slug = str(payload.model_slug) ?? '?'
    const tier = str(payload.tier)
    const input = num(payload.input_per_mtok)
    const output = num(payload.output_per_mtok)
    const price =
      input === null && output === null
        ? 'no published price'
        : `${money(input)} in / ${money(output)} out per Mtok`
    return `${slug}${tier ? ` (${tier})` : ''} — ${price}`
  }
  if (entityType === 'job') {
    const parts = [str(payload.title) ?? '?', str(payload.department), str(payload.location)]
    return parts.filter((p): p is string => Boolean(p)).join(' · ')
  }
  if (entityType === 'filing') {
    const names = Array.isArray(payload.display_names) ? payload.display_names : []
    const filer = str(names[0]) ?? str(payload.whitelist_cik) ?? '?'
    return [str(payload.form) ?? '?', filer, str(payload.file_date)]
      .filter((p): p is string => Boolean(p))
      .join(' · ')
  }
  if (entityType === 'incident') {
    const parts = [
      str(payload.title) ?? '?',
      str(payload.impact),
      payload.resolved_at === null ? 'open' : str(payload.status),
    ]
    return parts.filter((p): p is string => Boolean(p)).join(' · ')
  }
  if (entityType === 'disclosure') {
    return [str(payload.kind) ?? '?', str(payload.title) ?? '?', str(payload.model)]
      .filter((p): p is string => Boolean(p))
      .join(' · ')
  }
  if (entityType === 'disclosure_timeline') {
    return [
      str(payload.title) ?? '?',
      `discovered ${str(payload.discovered_on) ?? 'not stated'}`,
      str(payload.disclosed_on) ? `disclosed ${str(payload.disclosed_on)}` : null,
    ]
      .filter((p): p is string => Boolean(p))
      .join(' · ')
  }
  if (entityType === 'ranking') {
    const tokens = num(payload.total_tokens)
    return `${str(payload.model_permaslug) ?? '?'} · ${str(payload.date) ?? '?'} · ${tokens === null ? '?' : countLabel(tokens)} tokens`
  }
  if (entityType === 'recommendation') {
    const verdict =
      payload.present === false
        ? 'vendor sentence no longer on the page'
        : 'vendor sentence on the page'
    return `${str(payload.class) ?? '?'} → ${str(payload.model_slug) ?? '?'} · ${verdict}`
  }
  if (entityType === 'filer') {
    return [
      str(payload.name) ?? '?',
      `CIK ${str(payload.cik) ?? '?'}`,
      `resolved from ${str(payload.resolved_form) ?? '?'} ${str(payload.resolved_file_date) ?? ''}`.trim(),
    ].join(' · ')
  }
  if (entityType === 'offering') {
    const low = num(payload.price_low)
    const high = num(payload.price_high)
    const price = num(payload.price)
    const amendment = num(payload.amendment_no)
    return [
      str(payload.entity_name) ?? '?',
      `${str(payload.form) ?? '?'}${amendment === null ? '' : ` (Amendment No. ${amendment})`}`,
      price !== null
        ? `priced at ${money(price)}`
        : low !== null && high !== null
          ? `range ${money(low)}–${money(high)}`
          : 'range blank',
      str(payload.symbol),
    ]
      .filter((p): p is string => Boolean(p))
      .join(' · ')
  }
  if (entityType === 'statement') {
    const lines = Array.isArray(payload.lines) ? payload.lines : []
    return [
      str(payload.entity_name) ?? '?',
      str(payload.form),
      `statement of operations ${str(payload.start) ?? '?'} → ${str(payload.end) ?? '?'}`,
      `${lines.length} lines`,
    ]
      .filter((p): p is string => Boolean(p))
      .join(' · ')
  }
  if (entityType === 'commitment') {
    return [
      str(payload.entity_name) ?? '?',
      str(payload.form),
      `${String(payload.schedule ?? '?').replace(/_/g, ' ')}${str(payload.as_of) ? ` as of ${str(payload.as_of)}` : ''}`,
    ]
      .filter((p): p is string => Boolean(p))
      .join(' · ')
  }
  if (entityType === 'concentration') {
    const customers = Array.isArray(payload.customers) ? payload.customers.length : 0
    return [
      str(payload.entity_name) ?? '?',
      str(payload.form),
      `${payload.basis === 'accounts_receivable' ? 'receivables' : 'revenue'} concentration · ${customers} customers at 10% or more`,
    ]
      .filter((p): p is string => Boolean(p))
      .join(' · ')
  }
  if (entityType === 'shares') {
    return [str(payload.entity_name) ?? '?', str(payload.form), 'share counts in “The Offering”']
      .filter((p): p is string => Boolean(p))
      .join(' · ')
  }
  if (entityType === 'risk_factors') {
    const sections = Array.isArray(payload.sections) ? payload.sections : []
    const headings = sections.reduce(
      (n: number, s: unknown) =>
        n +
        (typeof s === 'object' &&
        s !== null &&
        Array.isArray((s as { headings?: unknown }).headings)
          ? (s as { headings: unknown[] }).headings.length
          : 0),
      0,
    )
    return [str(payload.entity_name) ?? '?', str(payload.form), `${headings} risk-factor headings`]
      .filter((p): p is string => Boolean(p))
      .join(' · ')
  }
  if (entityType === 'revenue') {
    const val = num(payload.val)
    return [
      str(payload.entity_name) ?? str(payload.cik) ?? '?',
      str(payload.tag),
      `${str(payload.start) ?? '?'} → ${str(payload.end) ?? '?'}`,
      val === null ? '?' : `USD ${countLabel(val)}`,
      str(payload.form),
    ]
      .filter((p): p is string => Boolean(p))
      .join(' · ')
  }
  return entityType
}

function toChangeView(row: typeof tables.changes.$inferSelect): ChangeView {
  const before = parseJson(row.before_json)
  const after = parseJson(row.after_json)
  return {
    id: row.id,
    entity_key: row.entity_key,
    entity_type: row.entity_type as ChangeView['entity_type'],
    provider: row.provider as ProviderId,
    change_type: row.change_type as ChangeView['change_type'],
    detected_at: row.detected_at,
    summary: summarize(row.entity_type, after ?? before),
    diff: row.change_type === 'modified' ? fieldDiff(before, after) : [],
    source_url: row.source_url,
    fetched_at: row.fetched_at,
  }
}

/** The permalink's reading of a change: the whole record, both sides. */
function toChangeDetail(row: typeof tables.changes.$inferSelect): ChangeDetailView {
  return {
    ...toChangeView(row),
    fields: fieldTable(parseJson(row.before_json), parseJson(row.after_json)),
  }
}

/** One IN() per 90 ids — D1 binds at most 100 parameters per statement. */
async function changesById<T>(
  db: PipelineDb,
  ids: readonly string[],
  view: (row: typeof tables.changes.$inferSelect) => T,
): Promise<Map<string, T>> {
  const out = new Map<string, T>()
  for (let i = 0; i < ids.length; i += 90) {
    const slice = ids.slice(i, i + 90)
    const rows = await db.select().from(tables.changes).where(inArray(tables.changes.id, slice))
    for (const row of rows) out.set(row.id, view(row))
  }
  return out
}

function parseChangeIds(text: string): string[] {
  try {
    const ids = JSON.parse(text) as unknown
    return Array.isArray(ids) ? ids.map(String) : []
  } catch {
    return []
  }
}

/** Alert rows with their cited change rows resolved through `view`. */
async function resolveAlerts<C extends ChangeView>(
  db: PipelineDb,
  rows: readonly (typeof tables.alerts.$inferSelect)[],
  view: (row: typeof tables.changes.$inferSelect) => C,
): Promise<(Omit<AlertView, 'changes'> & { changes: C[] })[]> {
  const parsedIds = rows.map((row) => parseChangeIds(row.change_ids))
  const cited = await changesById(db, [...new Set(parsedIds.flat())], view)
  return rows.map((row, i) => {
    const ids = parsedIds[i]!
    return {
      id: row.id,
      severity: row.severity as AlertSeverity,
      headline: row.headline,
      explanation: row.explanation,
      rule: row.rule as AlertView['rule'],
      created_at: row.created_at,
      change_ids: ids,
      changes: ids.map((id) => cited.get(id)).filter((c): c is C => c !== undefined),
      missing_change_ids: ids.filter((id) => !cited.has(id)),
      source_url: row.source_url,
      fetched_at: row.fetched_at,
    }
  })
}

/** The WHERE for a tier filter; undefined admits every severity. */
const tierWhere = (tier: AlertTierFilter) =>
  tier === 'all' ? undefined : inArray(tables.alerts.severity, severitiesOf(tier))

export async function queryAlerts(
  db: PipelineDb,
  ctx: QueryContext,
  limit: number,
  tier: AlertTierFilter = 'all',
): Promise<AlertsData> {
  let where = tierWhere(tier)
  if (ctx.at !== null) {
    where = and(where, alertsKnownAt(ctx.at, await judgeCutoffAt(db, ctx.at)))
    ctx.notes.method.add(ALERTS_METHOD)
  }
  const rows = await db
    .select()
    .from(tables.alerts)
    .where(where)
    .orderBy(desc(tables.alerts.created_at), asc(tables.alerts.id))
    .limit(limit)
  const [totalRow] = await db.select({ total: count() }).from(tables.alerts).where(where)
  const views = await resolveAlerts(db, rows, toChangeView)
  return { ...stampOf(ctx), tier, rows: views, total: totalRow?.total ?? 0 }
}

/** One alert by id, its cited rows in full; null when no such alert. */
export async function queryAlert(
  db: PipelineDb,
  ctx: QueryContext,
  id: string,
): Promise<AlertDetailData | null> {
  const rows = await db.select().from(tables.alerts).where(eq(tables.alerts.id, id)).limit(1)
  const [alert] = await resolveAlerts(db, rows, toChangeDetail)
  return alert ? { ...stampOf(ctx), alert } : null
}

export interface AlertPermalink {
  id: string
  tier: ReturnType<typeof alertTier>
  /** The alert's own created_at — its lastmod, since an alert row is never rewritten. */
  created_at: string
}

/** Every alert, newest first, for the sitemap's dynamic entries. */
export async function alertPermalinks(db: PipelineDb, limit = 5000): Promise<AlertPermalink[]> {
  const rows = await db
    .select({
      id: tables.alerts.id,
      severity: tables.alerts.severity,
      created_at: tables.alerts.created_at,
    })
    .from(tables.alerts)
    .orderBy(desc(tables.alerts.created_at), asc(tables.alerts.id))
    .limit(limit)
  return rows.map((row) => ({
    id: row.id,
    tier: alertTier(row.severity as AlertSeverity),
    created_at: row.created_at,
  }))
}

// ---- overview --------------------------------------------------------------

export const OVERVIEW_ALERTS = 10
export const OVERVIEW_INFO = 8

export async function queryOverview(db: PipelineDb, ctx: QueryContext): Promise<OverviewData> {
  const [movement, alerts, info, totals, stamps] = await Promise.all([
    queryMovement(db),
    queryAlerts(db, ctx, OVERVIEW_ALERTS, 'alert'),
    queryAlerts(db, ctx, OVERVIEW_INFO, 'info'),
    tableCounts(db),
    sourceStamps(db),
  ])
  const latest =
    [...stamps.values()]
      .map((s) => s.newest.fetched_at)
      .sort(byString)
      .at(-1) ?? null
  return {
    ...stampOf(ctx),
    movement,
    alerts: alerts.rows,
    alert_count: alerts.total,
    info: info.rows,
    info_count: info.total,
    totals,
    latest_fetched_at: latest,
  }
}

// ---- prices ----------------------------------------------------------------

const MATRIX_TIER_NOTE =
  'List price on each vendor’s standard tier. Batch, long-context, promo-window, and cached-only prices are left out here. They’re in the full catalog.'

const isStandardTier = (tier: string | null): boolean => tier === null || tier === 'standard'

const pricedRow = (r: PriceRowView) => r.input_per_mtok !== null || r.output_per_mtok !== null

/** Prefer a priced row, then the one carrying more fields (prices, then the
 * context window — the OpenAI model page beats the pricing page on that),
 * then the newest fetch. */
function preferRow(a: PriceRowView, b: PriceRowView): number {
  const priced = Number(pricedRow(b)) - Number(pricedRow(a))
  if (priced !== 0) return priced
  const fields = (r: PriceRowView) =>
    Number(r.input_per_mtok !== null) +
    Number(r.cached_input_per_mtok !== null) +
    Number(r.output_per_mtok !== null) +
    Number(r.context_window !== null)
  const richer = fields(b) - fields(a)
  if (richer !== 0) return richer
  if (a.fetched_at !== b.fetched_at) return a.fetched_at < b.fetched_at ? 1 : -1
  return byString(a.source_id, b.source_id)
}

function priceRowFromPayload(
  base: {
    entity_key: string
    source_id: string
    provider: string
    source_url: string
    fetched_at: string
  },
  payload: Json,
): PriceRowView {
  return {
    entity_key: base.entity_key,
    source_id: base.source_id,
    provider: base.provider as ProviderId,
    model_slug: str(payload.model_slug) ?? '?',
    tier: str(payload.tier),
    context_window: str(payload.context_window),
    context_window_source: null,
    input_per_mtok: num(payload.input_per_mtok),
    cached_input_per_mtok: num(payload.cached_input_per_mtok),
    output_per_mtok: num(payload.output_per_mtok),
    effective_from: str(payload.effective_from),
    effective_until: str(payload.effective_until),
    notes: str(payload.notes),
    removed: false,
    delta: null,
    also_listed_by: [],
    revisions: 0,
    spark: null,
    source_url: base.source_url,
    fetched_at: base.fetched_at,
  }
}

type ChangeRow = typeof tables.changes.$inferSelect

/** Every model change, oldest first — the history behind deltas and sparklines. */
async function modelChanges(db: PipelineDb): Promise<ChangeRow[]> {
  const rows = await db.select().from(tables.changes).where(eq(tables.changes.entity_type, 'model'))
  return rows.sort(byDetectedAt)
}

/** Earliest fetch per source URL — when watching began, for the opening history point. */
async function firstSnapshotByUrl(db: PipelineDb): Promise<Map<string, string>> {
  const rows = await firstSnapshotPerSource(db)
  return new Map(rows.map((r) => [r.source_url, r.fetched_at]))
}

/** Newest change per (entity_key, source_url), from a list already sorted oldest first. */
function newestPerSource(changes: readonly ChangeRow[]): Map<string, ChangeRow> {
  const out = new Map<string, ChangeRow>()
  for (const change of changes) out.set(`${change.entity_key} ${change.source_url}`, change)
  return out
}

function groupByKey<T extends { entity_key: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) out.set(row.entity_key, [...(out.get(row.entity_key) ?? []), row])
  return out
}

function toDelta(change: typeof tables.changes.$inferSelect): PriceDeltaView {
  const before = parseJson(change.before_json)
  const after = parseJson(change.after_json)
  return {
    change_type: change.change_type as PriceDeltaView['change_type'],
    detected_at: change.detected_at,
    input_before: before ? num(before.input_per_mtok) : null,
    input_after: after ? num(after.input_per_mtok) : null,
    output_before: before ? num(before.output_per_mtok) : null,
    output_after: after ? num(after.output_per_mtok) : null,
    source_url: change.source_url,
    fetched_at: change.fetched_at,
  }
}

const PRICES_METHOD =
  'The like-for-like matrix maps classes with the hand-transcribed class map in today’s code, overlaid with the judge’s class-map decisions made by as_of.'

export async function queryPrices(db: PipelineDb, ctx: QueryContext): Promise<PricesData> {
  const pit = atOf(ctx)
  const models = pit ? rewound(db, pit, 'model') : null
  if (pit) ctx.notes.method.add(PRICES_METHOD)
  const [entities, history, stamps, firsts, checks, classMap] = await Promise.all([
    models
      ? models.then((m) => m.rows)
      : db.select().from(tables.entities).where(eq(tables.entities.entity_type, 'model')),
    models ? models.then((m) => m.changes) : modelChanges(db),
    sourceStamps(db, ctx.at),
    firstSnapshotByUrl(db),
    pit
      ? rewound(db, pit, 'recommendation').then((r) => r.rows)
      : db.select().from(tables.entities).where(eq(tables.entities.entity_type, 'recommendation')),
    effectiveClassMap(db, ctx.at),
  ])
  const changes = newestPerSource(history)
  const entitiesByKey = groupByKey(entities)
  const historyByKey = groupByKey(history)
  const sourceId = (url: string) => sourceIdForUrl(url, ctx)
  const firstOf = (url: string) => firsts.get(url) ?? null

  // One view per stored row, then collapse to one per SKU key.
  const byKey = new Map<string, PriceRowView[]>()
  for (const e of entities) {
    const payload = parseJson(e.payload)
    if (!payload || typeof payload.model_slug !== 'string') continue
    const row = priceRowFromPayload(e, payload)
    const change = changes.get(`${e.entity_key} ${e.source_url}`)
    if (change) row.delta = toDelta(change)
    const list = byKey.get(e.entity_key) ?? []
    list.push(row)
    byKey.set(e.entity_key, list)
  }

  const rows: PriceRowView[] = []
  for (const [key, candidates] of byKey) {
    candidates.sort(preferRow)
    const [winner, ...rest] = candidates
    winner!.also_listed_by = rest.map((r) => r.source_id).sort(byString)
    // The row cites one source, so its sparkline is that source's
    // observations; the other page's are on the SKU's own page.
    const points = priceHistory(
      entitiesByKey.get(key) ?? [],
      historyByKey.get(key) ?? [],
      sourceId,
      firstOf,
    ).filter((p) => p.source_url === winner!.source_url)
    winner!.revisions = points.length
    winner!.spark = sparkOf(points)
    rows.push(winner!)
  }

  // A row whose source prints no window takes the one another stored row of
  // the same model prints, and cites it: Google's pricing page omits windows
  // that its model pages print, and a window holds for every tier.
  const windows = new Map<string, PriceRowView>()
  for (const r of [...byKey.values()].flat()) {
    if (r.context_window === null) continue
    const k = `${r.provider}:${r.model_slug}`
    const held = windows.get(k)
    if (
      !held ||
      held.fetched_at < r.fetched_at ||
      (held.fetched_at === r.fetched_at && r.source_id < held.source_id)
    )
      windows.set(k, r)
  }
  for (const r of rows) {
    const from = r.context_window === null ? windows.get(`${r.provider}:${r.model_slug}`) : null
    if (!from) continue
    r.context_window = from.context_window
    r.context_window_source = {
      source_id: from.source_id,
      source_url: from.source_url,
      fetched_at: from.fetched_at,
    }
  }

  // A delisted SKU: its newest change is a removal and no current row exists.
  for (const change of changes.values()) {
    if (change.change_type !== 'removed' || byKey.has(change.entity_key)) continue
    const before = parseJson(change.before_json)
    if (!before || typeof before.model_slug !== 'string') continue
    const row = priceRowFromPayload(
      {
        entity_key: change.entity_key,
        source_id: sourceIdForUrl(change.source_url, ctx),
        provider: change.provider,
        source_url: change.source_url,
        fetched_at: change.fetched_at,
      },
      before,
    )
    row.removed = true
    row.delta = toDelta(change)
    const points = priceHistory([], historyByKey.get(change.entity_key) ?? [], sourceId, firstOf)
    row.revisions = points.length
    row.spark = sparkOf(points)
    byKey.set(change.entity_key, [row])
    rows.push(row)
  }

  // Priced first, then catalog-only, then delisted; provider order inside each.
  rows.sort((a, b) => {
    const bucket = (r: PriceRowView) => (r.removed ? 2 : pricedRow(r) ? 0 : 1)
    const rank = bucket(a) - bucket(b)
    if (rank !== 0) return rank
    const p = (PROVIDER_RANK[a.provider] ?? 9) - (PROVIDER_RANK[b.provider] ?? 9)
    if (p !== 0) return p
    if (a.model_slug !== b.model_slug) return byString(a.model_slug, b.model_slug)
    return byString(a.tier ?? '', b.tier ?? '')
  })

  const openrouter = stamps.get('openrouter-models')
  const openrouterSource = ctx.registry.sources.find((s) => s.source_id === 'openrouter-models')

  return {
    ...stampOf(ctx),
    rows,
    matrix: buildMatrix(rows, basisChecks(checks), classMap),
    counts: {
      total: rows.length,
      priced: rows.filter((r) => !r.removed && pricedRow(r)).length,
      catalog_only: rows.filter((r) => !r.removed && !pricedRow(r)).length,
      removed: rows.filter((r) => r.removed).length,
    },
    changes_available: changes.size > 0,
    cross_check: openrouter
      ? {
          source_id: 'openrouter-models',
          label: labelOf('openrouter-models').label,
          caveat: openrouterSource?.caveat ?? null,
          snapshot: openrouter.newest,
        }
      : null,
  }
}

/** A change row carries no source_id; recover it from the audited URL. */
function sourceIdForUrl(url: string, ctx: QueryContext): string {
  return (
    manifestFixtures.find((f) => f.source_url === url)?.source_id ??
    ctx.registry.sources.find((s) => s.url === url)?.source_id ??
    '(unknown source)'
  )
}

/** The last poll's verdict on one mapped cell (layers/terminal/server/pipeline/recommendations.ts). */
export interface BasisCheck {
  provider: string
  class: string
  /** The slug the check was run for — a check for a superseded mapping is ignored. */
  model_slug: string
  present: boolean
  fetched_at: string
}

/** Stored 'recommendation' entities as checks, keyed by provider:class. */
export function basisChecks(
  entities: readonly (typeof tables.entities.$inferSelect)[],
): Map<string, BasisCheck> {
  const out = new Map<string, BasisCheck>()
  for (const e of entities) {
    const payload = parseJson(e.payload)
    if (!payload) continue
    const provider = str(payload.provider)
    const klass = str(payload.class)
    const model_slug = str(payload.model_slug)
    if (!provider || !klass || !model_slug || typeof payload.present !== 'boolean') continue
    out.set(`${provider}:${klass}`, {
      provider,
      class: klass,
      model_slug,
      present: payload.present,
      fetched_at: e.fetched_at,
    })
  }
  return out
}

/**
 * Joins the editorial class map (terminal-classes.ts) to real stored rows.
 * Nothing is computed about a model here: the map says which slug answers
 * which question, the store says what that slug costs, and anything the two
 * cannot answer becomes a stated gap. `checks` is the last poll's word on
 * whether each mapping's vendor sentence is still on the page. `classMap` is
 * the map in effect — the seed plus judge decisions (layers/terminal/server/pipeline/class-map.ts).
 */
export function buildMatrix(
  rows: readonly PriceRowView[],
  checks: ReadonlyMap<string, BasisCheck> = new Map(),
  classMap: readonly ClassEntry[] = MODEL_CLASS_MAP,
): PriceMatrix {
  const bySlug = new Map<string, PriceRowView[]>()
  for (const row of rows) {
    if (row.removed || !isStandardTier(row.tier)) continue
    const key = `${row.provider}:${row.model_slug}`
    bySlug.set(key, [...(bySlug.get(key) ?? []), row])
  }

  const cells: MatrixCell[] = []
  for (const provider of PROVIDER_ORDER) {
    for (const klass of MODEL_CLASSES) {
      const entry = classMap.find((e) => e.provider === provider && e.class === klass.id)
      if (!entry) {
        const gap = CLASS_GAPS.find((g) => g.provider === provider && g.class === klass.id)
        cells.push({
          provider,
          class: klass.id,
          row: null,
          basis: null,
          basis_source_id: null,
          basis_current: null,
          basis_checked_at: null,
          basis_note: null,
          gap: gap?.reason ?? 'No mapping. The vendor doesn’t name a model for this class.',
          priced: false,
        })
        continue
      }
      // Never merge fields across sources: the cell's provenance is one row's.
      const row =
        (bySlug.get(`${provider}:${entry.model_slug}`) ?? []).slice().sort(preferRow)[0] ?? null
      const priced = row !== null && pricedRow(row)
      // A check for a slug this map no longer names is a verdict on the
      // previous transcription, not this one: it waits for the next poll.
      // Until then a judge decision's own verification — the Worker found the
      // sentence on the stored page — is the newest word, and whichever of
      // the two is newer wins.
      const check = checks.get(`${provider}:${klass.id}`)
      const polled = check && check.model_slug === entry.model_slug ? check : null
      let current: { present: boolean; fetched_at: string } | null = polled
      if (entry.verified_at && (!current || entry.verified_at > current.fetched_at)) {
        current = { present: true, fetched_at: entry.verified_at }
      }
      cells.push({
        provider,
        class: klass.id,
        row,
        basis: entry.basis,
        basis_source_id: entry.basis_source_id,
        basis_current: current ? current.present : null,
        basis_checked_at: current ? current.fetched_at : null,
        basis_note: current && !current.present ? BASIS_STALE_NOTE : null,
        gap: priced ? null : row ? (PRICE_GAPS[provider as LabId] ?? NO_ROW_GAP) : NO_ROW_GAP,
        priced,
      })
    }
  }

  return {
    classes: MODEL_CLASSES,
    providers: [...PROVIDER_ORDER],
    cells,
    tier_note: MATRIX_TIER_NOTE,
  }
}

// ---- hiring ----------------------------------------------------------------

/** queryHiring's three grouped reads, over the job set rebuilt at ctx.at. */
async function hiringAggregatesAt(
  db: PipelineDb,
  ctx: QueryContext & { at: string },
): Promise<
  [
    { provider: string; department: string | null; n: number }[],
    { provider: string; company: string | null }[],
    { provider: string; source_id: string; source_url: string; fetched_at: string | null }[],
    Map<string, SourceStamp>,
  ]
> {
  const [jobs, stamps] = await Promise.all([rewound(db, ctx, 'job'), sourceStamps(db, ctx.at)])
  const departments = new Map<string, { provider: string; department: string | null; n: number }>()
  const companies = new Map<string, { provider: string; company: string | null }>()
  const sources = new Map<
    string,
    { provider: string; source_id: string; source_url: string; fetched_at: string | null }
  >()
  for (const e of jobs.rows) {
    const payload = parseJson(e.payload)
    const department = str(payload?.department)
    const company = str(payload?.company_name)
    const d = departments.get(`${e.provider}\n${department}`)
    if (d) d.n++
    else departments.set(`${e.provider}\n${department}`, { provider: e.provider, department, n: 1 })
    companies.set(`${e.provider}\n${company}`, { provider: e.provider, company })
    const k = `${e.provider}\n${e.source_id}\n${e.source_url}`
    const s = sources.get(k)
    const { provider, source_id, source_url, fetched_at } = e
    if (!s) sources.set(k, { provider, source_id, source_url, fetched_at })
    else if (s.fetched_at === null || fetched_at > s.fetched_at) s.fetched_at = fetched_at
  }
  return [[...departments.values()], [...companies.values()], [...sources.values()], stamps]
}

export async function queryHiring(db: PipelineDb, ctx: QueryContext): Promise<HiringData> {
  const department = sql<string | null>`json_extract(${tables.entities.payload}, '$.department')`
  const company = sql<string | null>`json_extract(${tables.entities.payload}, '$.company_name')`
  const isJob = eq(tables.entities.entity_type, 'job')

  const pit = atOf(ctx)
  const [departments, companies, sources, stamps] = pit
    ? await hiringAggregatesAt(db, pit)
    : await Promise.all([
        db
          .select({ provider: tables.entities.provider, department, n: count() })
          .from(tables.entities)
          .where(isJob)
          .groupBy(tables.entities.provider, department),
        db
          .select({ provider: tables.entities.provider, company })
          .from(tables.entities)
          .where(isJob)
          .groupBy(tables.entities.provider, company),
        db
          .select({
            provider: tables.entities.provider,
            source_id: tables.entities.source_id,
            source_url: tables.entities.source_url,
            fetched_at: max(tables.entities.fetched_at),
          })
          .from(tables.entities)
          .where(isJob)
          .groupBy(tables.entities.provider, tables.entities.source_id, tables.entities.source_url),
        sourceStamps(db),
      ])

  const xaiCaveat = ctx.registry.sources.find((s) => s.source_id === 'xai-greenhouse')?.caveat

  const providers: HiringProviderView[] = []
  for (const provider of PROVIDER_ORDER) {
    const backing = HIRING_SOURCES[provider]
    if ('cut_id' in backing) {
      // Honest cut — never a fabricated number (sources.yaml `cut.<lab>-hiring`).
      providers.push({
        provider,
        display: PROVIDER_DISPLAY[provider],
        feed: 'no_public_feed',
        reason:
          cutReason(ctx, backing.cut_id) ??
          `No public hiring feed exists for ${PROVIDER_DISPLAY[provider]}.`,
        total: 0,
        departments: [],
        caveat: null,
        company_names: [],
        sources: [],
      })
      continue
    }

    const depts: DeptCount[] = departments
      .filter((d) => d.provider === provider)
      .map((d) => ({ department: d.department ?? NO_DEPARTMENT, count: d.n }))
      .sort((a, b) => b.count - a.count || byString(a.department, b.department))
    const total = depts.reduce((acc, d) => acc + d.count, 0)

    const rowSources: HiringSource[] = sources
      .filter((s) => s.provider === provider && s.fetched_at)
      .map((s) => ({
        source_id: s.source_id,
        label: labelOf(s.source_id).label,
        source_url: s.source_url,
        fetched_at: s.fetched_at!,
      }))
    // No rows yet: cite the feed snapshots, if any were captured.
    const feedSources: HiringSource[] = backing.source_ids
      .map((id) => {
        const stamp = stamps.get(id)
        return stamp
          ? {
              source_id: id,
              label: labelOf(id).label,
              source_url: stamp.newest.source_url,
              fetched_at: stamp.newest.fetched_at,
            }
          : null
      })
      .filter((s): s is HiringSource => s !== null)

    providers.push({
      provider,
      display: PROVIDER_DISPLAY[provider],
      feed: total > 0 ? 'ok' : 'no_rows',
      reason: null,
      total,
      departments: depts,
      caveat: provider === 'xai' ? (xaiCaveat ?? null) : null,
      company_names: companies
        .filter((c) => c.provider === provider && c.company)
        .map((c) => c.company!)
        .sort(byString),
      sources: total > 0 ? rowSources : feedSources,
    })
  }

  return { ...stampOf(ctx), providers }
}

// ---- incidents (capacity strain) -------------------------------------------

export const INCIDENT_WINDOW_DAYS = 30
export const INCIDENT_HISTORY_DAYS = 90

const DAY_MS = 86_400_000

function incidentFromPayload(
  base: {
    entity_key: string
    source_id: string
    provider: string
    source_url: string
    fetched_at: string
  },
  payload: Json,
): IncidentView | null {
  const incident_id = str(payload.incident_id)
  const title = str(payload.title)
  const started_at = str(payload.started_at)
  const incident_url = str(payload.incident_url)
  if (!incident_id || !title || !started_at || !incident_url) return null
  const components = Array.isArray(payload.components)
    ? payload.components.filter((c): c is string => typeof c === 'string')
    : []
  return {
    entity_key: base.entity_key,
    source_id: base.source_id,
    provider: base.provider as LabId,
    incident_id,
    title,
    impact: str(payload.impact),
    status: str(payload.status) ?? '?',
    started_at,
    resolved_at: str(payload.resolved_at),
    components,
    incident_url,
    source_url: base.source_url,
    fetched_at: base.fetched_at,
  }
}

/** Newest started_at first; id breaks ties so the order is total. */
const newestFirst = (a: IncidentView, b: IncidentView) =>
  a.started_at === b.started_at
    ? byString(a.entity_key, b.entity_key)
    : a.started_at < b.started_at
      ? 1
      : -1

/**
 * Incident counts are windows over `started_at` as the vendor posted it,
 * anchored to the newest status-feed fetch rather than the reader's clock —
 * the same reason the signal band anchors to the newest detection. The
 * anchor ships in the payload so the claim is checkable, and each provider
 * reports where its held history begins: a Statuspage feed is a rolling
 * window, so the prior-30-day count is partial until the pipeline has
 * polled through it, and the UI says so rather than printing a low number.
 */
export async function queryIncidents(db: PipelineDb, ctx: QueryContext): Promise<IncidentsData> {
  const [entities, stamps] = await Promise.all([
    db.select().from(tables.entities).where(eq(tables.entities.entity_type, 'incident')),
    sourceStamps(db),
  ])

  const feedStamps = Object.values(INCIDENT_SOURCES)
    .flatMap((b) => ('source_id' in b ? [stamps.get(b.source_id)] : []))
    .filter((s): s is SourceStamp => s !== undefined)
  const windowTo =
    feedStamps
      .map((s) => s.newest.fetched_at)
      .sort(byString)
      .at(-1) ?? ctx.now().toISOString()
  const toMs = Date.parse(windowTo)
  const lastFrom = toMs - INCIDENT_WINDOW_DAYS * DAY_MS
  const priorFrom = toMs - 2 * INCIDENT_WINDOW_DAYS * DAY_MS
  const historyFrom = toMs - INCIDENT_HISTORY_DAYS * DAY_MS

  const all: IncidentView[] = []
  for (const e of entities) {
    const payload = parseJson(e.payload)
    const view = payload && incidentFromPayload(e, payload)
    if (view) all.push(view)
  }
  all.sort(newestFirst)

  const providers: IncidentProviderView[] = []
  for (const provider of PROVIDER_ORDER) {
    const backing = INCIDENT_SOURCES[provider]
    if ('cut_id' in backing) {
      // Honest cut — never a fabricated zero (sources.yaml `cut.<lab>-status`).
      providers.push({
        provider,
        display: PROVIDER_DISPLAY[provider],
        feed: 'no_public_feed',
        reason:
          cutReason(ctx, backing.cut_id) ??
          `No public status feed is reachable for ${PROVIDER_DISPLAY[provider]}.`,
        caveat: null,
        last_window: 0,
        prior_window: 0,
        open: [],
        coverage_from: null,
        sources: [],
      })
      continue
    }
    const sourceId = backing.source_id
    const rows = all.filter((i) => i.provider === provider)
    const startedMs = (i: IncidentView) => Date.parse(i.started_at)
    const stamp = stamps.get(sourceId)
    const sources: SourceRef[] = stamp
      ? [
          {
            source_id: sourceId,
            label: labelOf(sourceId).label,
            source_url: stamp.newest.source_url,
            fetched_at: stamp.newest.fetched_at,
          },
        ]
      : []
    providers.push({
      provider,
      display: PROVIDER_DISPLAY[provider],
      feed: rows.length > 0 ? 'ok' : 'no_rows',
      reason: null,
      caveat: ctx.registry.sources.find((s) => s.source_id === sourceId)?.caveat ?? null,
      last_window: rows.filter((i) => startedMs(i) > lastFrom && startedMs(i) <= toMs).length,
      prior_window: rows.filter((i) => startedMs(i) > priorFrom && startedMs(i) <= lastFrom).length,
      open: rows.filter((i) => i.resolved_at === null),
      coverage_from: rows.map((i) => i.started_at).sort(byString)[0] ?? null,
      sources,
    })
  }

  return {
    ...stampOf(ctx),
    window_to: windowTo,
    window_days: INCIDENT_WINDOW_DAYS,
    history_days: INCIDENT_HISTORY_DAYS,
    providers,
    incidents: all.filter((i) => Date.parse(i.started_at) > historyFrom),
  }
}

// ---- price history ---------------------------------------------------------

/** One SKU's observations, or null when the store has never seen the key. */
export async function queryPriceHistory(
  db: PipelineDb,
  ctx: QueryContext,
  key: string,
): Promise<PriceHistoryData | null> {
  const pit = atOf(ctx)
  const sku = pit ? rewound(db, pit, 'model', key) : null
  const [entities, changes, firsts] = await Promise.all([
    sku
      ? sku.then((r) => r.rows)
      : db
          .select()
          .from(tables.entities)
          .where(
            and(eq(tables.entities.entity_type, 'model'), eq(tables.entities.entity_key, key)),
          ),
    sku
      ? sku.then((r) => r.changes)
      : db
          .select()
          .from(tables.changes)
          .where(and(eq(tables.changes.entity_type, 'model'), eq(tables.changes.entity_key, key))),
    firstSnapshotByUrl(db),
  ])
  if (entities.length === 0 && changes.length === 0) return null

  const points = priceHistory(
    entities,
    changes,
    (url) => sourceIdForUrl(url, ctx),
    (url) => firsts.get(url) ?? null,
  )
  // Identity fields from the newest payload on record.
  const newest = [...changes].sort(byDetectedAt).at(-1)
  const payload =
    parseJson(entities[0]?.payload ?? null) ??
    parseJson(newest?.after_json ?? null) ??
    parseJson(newest?.before_json ?? null)
  const provider = (entities[0]?.provider ?? newest?.provider ?? 'other') as ProviderId
  return {
    ...stampOf(ctx),
    entity_key: key,
    provider,
    model_slug: str(payload?.model_slug) ?? '?',
    tier: str(payload?.tier),
    context_window: str(payload?.context_window),
    points,
    removed: entities.length === 0 && newest?.change_type === 'removed',
  }
}

/**
 * Every SKU key the store has a page for, with the newest observation as
 * its lastmod — the sitemap's dynamic entries.
 */
/**
 * The newest change per entity type and lab, and the newest alert: what
 * sitemap.xml dates each data page by (server/utils/seo.ts › dataLastmods).
 * One grouped scan rather than a query per page, because the sitemap asks
 * for every page at once.
 */
export async function queryDataFreshness(db: PipelineDb): Promise<DataFreshness> {
  const [changes, alerts] = await Promise.all([
    db
      .select({
        entity_type: tables.changes.entity_type,
        provider: tables.changes.provider,
        at: max(tables.changes.detected_at),
      })
      .from(tables.changes)
      .groupBy(tables.changes.entity_type, tables.changes.provider),
    db.select({ at: max(tables.alerts.created_at) }).from(tables.alerts),
  ])
  return {
    changes: changes.flatMap((row) => (row.at ? [{ ...row, at: row.at }] : [])),
    alertsAt: alerts[0]?.at ?? null,
  }
}

export async function queryPriceKeys(
  db: PipelineDb,
): Promise<{ entity_key: string; lastmod: string }[]> {
  const [current, logged] = await Promise.all([
    db
      .select({ entity_key: tables.entities.entity_key, at: max(tables.entities.fetched_at) })
      .from(tables.entities)
      .where(eq(tables.entities.entity_type, 'model'))
      .groupBy(tables.entities.entity_key),
    db
      .select({ entity_key: tables.changes.entity_key, at: max(tables.changes.detected_at) })
      .from(tables.changes)
      .where(eq(tables.changes.entity_type, 'model'))
      .groupBy(tables.changes.entity_key),
  ])
  const newest = new Map<string, string>()
  for (const row of [...current, ...logged]) {
    if (!row.at) continue
    const seen = newest.get(row.entity_key)
    if (!seen || Date.parse(row.at) > Date.parse(seen)) newest.set(row.entity_key, row.at)
  }
  return [...newest]
    .map(([entity_key, at]) => ({ entity_key, lastmod: dayOf(at) }))
    .sort((a, b) => byString(a.entity_key, b.entity_key))
}

// ---- hiring history --------------------------------------------------------

export const HIRING_WINDOW_DAYS = 30

/** Baseline (source_url, fetched_at) pairs: first snapshot per source, plus runs marked baseline. */
async function loadBaselineInstants(db: PipelineDb): Promise<Set<string>> {
  const [firsts, runs] = await Promise.all([
    firstSnapshotPerSource(db),
    db
      .select({ status: tables.sourceRuns.status, snapshot_id: tables.sourceRuns.snapshot_id })
      .from(tables.sourceRuns)
      .where(eq(tables.sourceRuns.status, 'baseline')),
  ])
  const ids = runs.map((r) => r.snapshot_id).filter((id): id is string => id !== null)
  const marked: { id: string; source_url: string; fetched_at: string }[] = []
  for (let i = 0; i < ids.length; i += 90) {
    marked.push(
      ...(await db
        .select({
          id: tables.snapshots.id,
          source_url: tables.snapshots.source_url,
          fetched_at: tables.snapshots.fetched_at,
        })
        .from(tables.snapshots)
        .where(inArray(tables.snapshots.id, ids.slice(i, i + 90)))),
    )
  }
  const snapshots = [
    ...firsts.map((f) => ({ id: '', source_url: f.source_url, fetched_at: f.fetched_at })),
    ...marked,
  ]
  return baselineInstants(snapshots, runs)
}

export async function queryHiringHistory(
  db: PipelineDb,
  ctx: QueryContext,
): Promise<HiringHistoryData> {
  const department = sql<string | null>`json_extract(${tables.entities.payload}, '$.department')`
  const isJob = eq(tables.entities.entity_type, 'job')
  // As of T: the job set rebuilt at T and the log up to it, so the series
  // ends at T exactly as /api/hiring?as_of=T counts it.
  const pit = atOf(ctx)
  const jobs = pit ? rewound(db, pit, 'job') : null
  const [roles, changes, firstSnapshots, baselines, stamps] = await Promise.all([
    jobs
      ? jobs.then((r) =>
          r.rows.map((e) => ({
            entity_key: e.entity_key,
            provider: e.provider,
            department: str(parseJson(e.payload)?.department),
          })),
        )
      : db
          .select({
            entity_key: tables.entities.entity_key,
            provider: tables.entities.provider,
            department,
          })
          .from(tables.entities)
          .where(isJob),
    jobs
      ? jobs.then((r) => r.changes)
      : db.select().from(tables.changes).where(eq(tables.changes.entity_type, 'job')),
    db
      .select({ source_id: tables.sourceStats.source_id, at: tables.sourceStats.first_fetched_at })
      .from(tables.sourceStats),
    db
      .select({ source_id: tables.sourceRuns.source_id, at: min(tables.sourceRuns.started_at) })
      .from(tables.sourceRuns)
      .where(eq(tables.sourceRuns.status, 'baseline'))
      .groupBy(tables.sourceRuns.source_id),
    sourceStamps(db, ctx.at),
  ])

  // A source first fetched after T did not exist yet.
  const known = <R extends { at: string | null }>(r: R) =>
    r.at !== null && (ctx.at === null || r.at <= ctx.at)
  const current: OpenRole[] = roles.map((r) => ({
    entity_key: r.entity_key,
    provider: r.provider,
    department: r.department ?? NO_DEPARTMENT,
  }))
  const firstOf = new Map(firstSnapshots.filter(known).map((s) => [s.source_id, s.at]))
  const baselineOf = new Map(baselines.filter(known).map((b) => [b.source_id, b.at]))
  const now = ctx.at ?? ctx.now().toISOString()
  const sorted = [...changes].sort(byDetectedAt)

  // One grid from the earliest board snapshot; each provider's series is cut
  // to start at its own.
  const earliest =
    Object.values(HIRING_SOURCES)
      .flatMap((b) => ('source_ids' in b ? [firstOf.get(b.source_ids[0]!) ?? null] : []))
      .filter((s): s is string => s !== null)
      .sort(byString)[0] ?? null
  const grid = earliest ? dailyInstants(dayOf(earliest), now) : []
  const byInstant = openRolesAt(
    current,
    sorted,
    grid.map((g) => g.at),
  )

  const xaiCaveat = ctx.registry.sources.find((s) => s.source_id === 'xai-greenhouse')?.caveat

  const providers: HiringHistoryProvider[] = []
  for (const provider of PROVIDER_ORDER) {
    const backing = HIRING_SOURCES[provider]
    if ('cut_id' in backing) {
      // Honest cut — never a fabricated series (sources.yaml `cut.<lab>-hiring`).
      providers.push({
        provider,
        display: PROVIDER_DISPLAY[provider],
        feed: 'no_public_feed',
        reason:
          cutReason(ctx, backing.cut_id) ??
          `No public hiring feed exists for ${PROVIDER_DISPLAY[provider]}.`,
        caveat: null,
        dates: [],
        total: [],
        departments: [],
        clusters: [],
        compare: null,
        series_from: null,
        baseline_at: null,
        join_from: null,
        sources: [],
      })
      continue
    }
    const [primary, join] = backing.source_ids as [string, string | undefined]
    const from = firstOf.get(primary) ?? null
    const own = from ? grid.filter((g) => g.date >= dayOf(from)) : []
    const { total, departments } = departmentSeries(byInstant, own, provider)
    const dates = own.map((g) => g.date)
    const sources: HiringSource[] = backing.source_ids
      .map((id) => {
        const stamp = stamps.get(id)
        return stamp
          ? {
              source_id: id,
              label: labelOf(id).label,
              source_url: stamp.newest.source_url,
              fetched_at: stamp.newest.fetched_at,
            }
          : null
      })
      .filter((s): s is HiringSource => s !== null)
    const open = total.at(-1) ?? 0
    const compare = compareWindow(dates, total, departments, HIRING_WINDOW_DAYS)
    const thenIndex = compare ? dates.indexOf(compare.at) : null
    providers.push({
      provider,
      display: PROVIDER_DISPLAY[provider],
      feed: open > 0 ? 'ok' : 'no_rows',
      reason: null,
      caveat: provider === 'xai' ? (xaiCaveat ?? null) : null,
      dates,
      total,
      departments,
      clusters: ctx.clusters.map((c) =>
        clusterSeries(c, departments, dates, thenIndex === -1 ? null : thenIndex),
      ),
      compare,
      series_from: from,
      baseline_at: baselineOf.get(primary) ?? null,
      join_from: join ? (firstOf.get(join) ?? null) : null,
      sources,
    })
  }

  return {
    ...stampOf(ctx),
    window_days: HIRING_WINDOW_DAYS,
    providers,
    log: {
      changes: sorted.length,
      from: sorted[0]?.detected_at ?? null,
      to: sorted.at(-1)?.detected_at ?? null,
    },
  }
}

// ---- releases --------------------------------------------------------------

export async function queryReleases(db: PipelineDb, ctx: QueryContext): Promise<ReleasesData> {
  const [added, baseline, [earliest]] = await Promise.all([
    db
      .select()
      .from(tables.changes)
      .where(and(eq(tables.changes.entity_type, 'model'), eq(tables.changes.change_type, 'added'))),
    loadBaselineInstants(db),
    db.select({ at: min(tables.snapshots.fetched_at) }).from(tables.snapshots),
  ])
  const { rows, excluded_baseline } = releaseEvents(added, baseline, (url) =>
    sourceIdForUrl(url, ctx),
  )
  return { ...stampOf(ctx), rows, excluded_baseline, log_from: earliest?.at ?? null }
}

// ---- coverage --------------------------------------------------------------

/** Newest recipe run (of `ids`, or of every recipe) — a cache key's variant, because
 * recipes run on the survey tick after the poll has stamped the cache. */
export async function recipeRunsStamp(db: PipelineDb, ids?: readonly string[]): Promise<string> {
  const [row] = await db
    .select({ at: max(tables.recipeRuns.started_at) })
    .from(tables.recipeRuns)
    .where(ids ? inArray(tables.recipeRuns.recipe_id, [...ids]) : undefined)
  return row?.at ?? 'none'
}

/** Every thesis recipe with its last run and what it has stored, beside its audit entry. */
async function recipeCoverage(db: PipelineDb, ctx: QueryContext): Promise<RecipeCoverage[]> {
  const [runs, counts, newest] = await Promise.all([
    db
      .select({
        recipe_id: tables.recipeRuns.recipe_id,
        status: tables.recipeRuns.status,
        started_at: tables.recipeRuns.started_at,
        detail: tables.recipeRuns.detail,
        source_url: tables.recipeRuns.source_url,
      })
      .from(tables.recipeRuns)
      .where(
        sql`${tables.recipeRuns.started_at} = (select max(r2.started_at) from recipe_runs r2 where r2.recipe_id = ${tables.recipeRuns.recipe_id})`,
      ),
    db
      .select({ recipe_id: tables.recipeObservations.recipe_id, n: count() })
      .from(tables.recipeObservations)
      .groupBy(tables.recipeObservations.recipe_id),
    db
      .selectDistinct({
        recipe_id: tables.recipeObservations.recipe_id,
        source_url: tables.recipeObservations.source_url,
        fetched_at: tables.recipeObservations.fetched_at,
      })
      .from(tables.recipeObservations)
      .where(
        sql`${tables.recipeObservations.fetched_at} = (select max(o2.fetched_at) from recipe_observations o2 where o2.recipe_id = ${tables.recipeObservations.recipe_id})`,
      ),
  ])
  const runOf = new Map(runs.map((r) => [r.recipe_id, r]))
  const countOf = new Map(counts.map((r) => [r.recipe_id, r.n]))
  const newestOf = new Map(newest.map((r) => [r.recipe_id, r]))
  return RECIPES.map((recipe) => {
    const run = runOf.get(recipe.id)
    const stored = newestOf.get(recipe.id)
    const audit = ctx.registry.recipes.find((r) => r.recipe_id === recipe.id)
    return {
      recipe_id: recipe.id,
      company: recipe.company,
      description: recipe.description,
      url: run?.source_url || recipe.url({ now: ctx.now(), newest: null }),
      last_run: run
        ? {
            status: run.status as NonNullable<RecipeCoverage['last_run']>['status'],
            started_at: run.started_at,
            detail: run.detail,
          }
        : null,
      observations: countOf.get(recipe.id) ?? 0,
      newest: stored ? { source_url: stored.source_url, fetched_at: stored.fetched_at } : null,
      caveat: audit?.caveat ?? null,
      terms: audit?.terms ?? null,
      rights: audit?.rights ?? null,
    }
  })
}

export async function queryCoverage(db: PipelineDb, ctx: QueryContext): Promise<CoverageData> {
  const [stamps, runs, counts, totals, [first]] = await Promise.all([
    sourceStamps(db),
    lastRuns(db),
    db
      .select({ source_id: tables.entities.source_id, n: count() })
      .from(tables.entities)
      .groupBy(tables.entities.source_id),
    tableCounts(db),
    db.select({ at: min(tables.sourceStats.first_fetched_at) }).from(tables.sourceStats),
  ])
  const entityCount = new Map(counts.map((c) => [c.source_id, c.n]))

  const sources: SourceCoverage[] = ctx.registry.sources.map((source) => {
    const stamp = stamps.get(source.source_id)
    const { label, role } = labelOf(source.source_id)
    return {
      source_id: source.source_id,
      label,
      provider: source.provider,
      axis: source.axis,
      role,
      caveat: source.caveat,
      license: source.license,
      terms: source.terms,
      rights: source.rights,
      // The manifest carries the resolved URL (query strings, the CIK) where
      // sources.yaml has a template.
      url: manifestFixtures.find((f) => f.source_id === source.source_id)?.source_url ?? source.url,
      newest_snapshot: stamp?.newest ?? null,
      snapshot_count: stamp?.snapshot_count ?? 0,
      last_run: runs.get(source.source_id) ?? null,
      entity_count: entityCount.get(source.source_id) ?? 0,
      derived_from: null,
    }
  })
  // Sources the store derived for itself (layers/terminal/server/pipeline/derived.ts) have no
  // registry entry; they are listed after the audited ones, named by their
  // template, so nothing that was fetched is invisible here.
  //
  // Enumerated over the runs as well as the snapshots, not the snapshots
  // alone. A derived url that 404s is fetched every tick and snapshots
  // nothing, so keying on snapshots hid exactly the sources with something to
  // say: five priced OpenAI SKUs whose model page does not exist were missing
  // from this panel entirely while the ops digest mailed about them.
  const registered = new Set(sources.map((s) => s.source_id))
  const derivedIds = [...new Set([...stamps.keys(), ...runs.keys()])].sort(byString)
  for (const source_id of derivedIds) {
    const stamp = stamps.get(source_id)
    const template = derivedTemplateOf(source_id)
    if (registered.has(source_id) || !template) continue
    const { label, role } = labelOf(source_id)
    const parent = ctx.registry.sources.find((s) => s.yaml_id === DERIVED_TERMS_FROM[template])
    const provider = source_id.startsWith('openai-')
      ? 'openai'
      : source_id.startsWith('google-')
        ? 'google'
        : ((PROVIDER_ORDER.find((p) => source_id.endsWith(`-${p}`)) ?? 'all') as ProviderId | 'all')
    sources.push({
      source_id,
      label,
      provider,
      axis:
        template === 'openai-model-md' || template === 'google-model-md'
          ? 'pricing-catalog'
          : template === 'edgar-companyfacts'
            ? 'revenue'
            : 'sec',
      role,
      caveat: ctx.derivedTemplates.find((t) => t.id === template)?.caveat ?? null,
      // A derived source has no registry entry and so states no licence of its
      // own; it inherits whatever the source it was derived from stated.
      license: null,
      terms: parent?.terms ?? null,
      rights: parent?.rights ?? null,
      // The newest snapshot's url, or — when there is no snapshot because the
      // fetch 404s — the url the last run went to.
      url: stamp?.newest.source_url ?? runs.get(source_id)?.source_url ?? '',
      newest_snapshot: stamp?.newest ?? null,
      snapshot_count: stamp?.snapshot_count ?? 0,
      last_run: runs.get(source_id) ?? null,
      entity_count: entityCount.get(source_id) ?? 0,
      derived_from: template,
    })
  }

  const exports = await Promise.all(
    Object.values(EXPORT_TABLES).map(async (table) => ({
      name: table.name,
      description: table.description,
      columns: [...table.columns],
      rows: await table.count(db),
    })),
  )

  const latest =
    [...stamps.values()]
      .map((s) => s.newest.fetched_at)
      .sort(byString)
      .at(-1) ?? null

  return {
    ...stampOf(ctx),
    sources,
    cuts: ctx.registry.cuts.map((c) => ({ id: c.id, verdict: c.verdict, reason: c.reason })),
    recipes: await recipeCoverage(db, ctx),
    track_record: ctx.registry.track_record.map(({ id, url, terms, rights, caveat }) => ({
      id,
      url,
      terms,
      rights,
      caveat,
    })),
    totals,
    exports,
    latest_fetched_at: latest,
    first_fetched_at: first?.at ?? null,
  }
}
