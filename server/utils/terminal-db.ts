// Read-only query layer over the pipeline tables — what every terminal page
// renders. The UI never writes: server/pipeline/store.ts › insertRows() is
// the only write path.
//
// Ported from the take-home's DuckDB queries onto Drizzle/D1, with one
// structural change the store forced: `entities` here IS the current set
// (one row per source and key, rewritten in place, deleted on removal), so
// "the newest revision per SKU" is the entity row and the previous revision
// is the newest `changes` row for that key. Jobs are a set — a role missing
// from the board is closed — so open roles are counted straight from
// `entities`. Prices are a series, so a delisted SKU stays visible, struck
// through, from its removal change.
//
// Every function takes the Drizzle client explicitly (the shape
// server/utils/fleet-status.ts uses) so test/terminal-db.test.ts drives them
// against the workerd D1.

import { and, asc, count, desc, eq, inArray, max, ne, sql } from 'drizzle-orm'

import { count as countLabel, money } from '#shared/utils/terminal-format'
import {
  alertTier,
  severitiesOf,
  type AlertSeverity,
  type AlertTierFilter,
} from '#shared/utils/terminal-tiers'
import type {
  AlertDetailData,
  AlertView,
  AlertsData,
  BigFour,
  ChangeDetailView,
  ChangeView,
  CoverageData,
  DeptCount,
  FieldDiff,
  HiringData,
  HiringProviderView,
  HiringSource,
  IncidentProviderView,
  IncidentView,
  IncidentsData,
  MatrixCell,
  MovementSummary,
  OverviewData,
  PriceDeltaView,
  PriceMatrix,
  PriceRowView,
  PricesData,
  ProviderId,
  SnapshotStamp,
  SourceCoverage,
  SourceRef,
  SourceRunStamp,
  Stamp,
  TableCounts,
} from '#shared/utils/terminal-types'

import * as tables from '../db/schema'
import { manifestFixtures } from '../pipeline/parsers/fixture-provenance'
import type { PipelineDb } from '../pipeline/store'
import {
  CLASS_GAPS,
  MODEL_CLASSES,
  MODEL_CLASS_MAP,
  NO_ROW_GAP,
  PRICE_GAPS,
} from './terminal-classes'
import { EXPORT_TABLES } from './terminal-export'
import {
  HIRING_SOURCE_IDS,
  INCIDENT_SOURCE_IDS,
  PROVIDER_DISPLAY,
  PROVIDER_ORDER,
  labelOf,
  readSourceRegistry,
  type SourceRegistry,
} from './terminal-sources'

/** What every query needs beyond the client: the registry and the tick it reports. */
export interface QueryContext {
  registry: SourceRegistry
  /** Newest source_runs.started_at, already read for the cache key. */
  as_of: string | null
  now: () => Date
}

export function queryContext(
  sourcesYaml: string,
  as_of: string | null,
  now: () => Date = () => new Date(),
): QueryContext {
  return { registry: readSourceRegistry(sourcesYaml), as_of, now }
}

const stampOf = (ctx: QueryContext): Stamp => ({
  as_of: ctx.as_of,
  computed_at: ctx.now().toISOString(),
})

type Json = Record<string, unknown>

function parseJson(text: string | null): Json | null {
  if (text === null) return null
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Json)
      : null
  } catch {
    return null
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const PROVIDER_RANK: Readonly<Record<string, number>> = {
  openai: 0,
  anthropic: 1,
  google: 2,
  xai: 3,
  other: 4,
}

// ---- snapshots and runs ------------------------------------------------------

export interface SourceStamp {
  source_id: string
  newest: SnapshotStamp
  snapshot_count: number
}

/** Newest snapshot per source, with how many that source has. */
export async function sourceStamps(db: PipelineDb): Promise<Map<string, SourceStamp>> {
  const newest = db
    .select({
      source_id: tables.snapshots.source_id,
      at: max(tables.snapshots.fetched_at).as('at'),
      n: count().as('n'),
    })
    .from(tables.snapshots)
    .groupBy(tables.snapshots.source_id)
    .as('newest')

  const rows = await db
    .select({
      source_id: tables.snapshots.source_id,
      source_url: tables.snapshots.source_url,
      fetched_at: tables.snapshots.fetched_at,
      http_status: tables.snapshots.http_status,
      bytes: tables.snapshots.bytes,
      n: newest.n,
    })
    .from(tables.snapshots)
    .innerJoin(
      newest,
      and(
        eq(tables.snapshots.source_id, newest.source_id),
        eq(tables.snapshots.fetched_at, newest.at),
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
      snapshot_count: Number(row.n),
    })
  }
  return out
}

/** Newest run per source — how the last poll of it ended. */
export async function lastRuns(db: PipelineDb): Promise<Map<string, SourceRunStamp>> {
  const newest = db
    .select({
      source_id: tables.sourceRuns.source_id,
      at: max(tables.sourceRuns.started_at).as('at'),
    })
    .from(tables.sourceRuns)
    .groupBy(tables.sourceRuns.source_id)
    .as('newest_run')

  const rows = await db
    .select({
      source_id: tables.sourceRuns.source_id,
      started_at: tables.sourceRuns.started_at,
      status: tables.sourceRuns.status,
      detail: tables.sourceRuns.detail,
      scope: tables.sourceRuns.scope,
    })
    .from(tables.sourceRuns)
    .innerJoin(
      newest,
      and(
        eq(tables.sourceRuns.source_id, newest.source_id),
        eq(tables.sourceRuns.started_at, newest.at),
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
    })
  }
  return out
}

export async function tableCounts(db: PipelineDb): Promise<TableCounts> {
  const total = async (
    table:
      | typeof tables.snapshots
      | typeof tables.entities
      | typeof tables.changes
      | typeof tables.alerts
      | typeof tables.sourceRuns,
  ) => {
    const [row] = await db.select({ total: count() }).from(table)
    return row?.total ?? 0
  }
  return {
    snapshots: await total(tables.snapshots),
    entities: await total(tables.entities),
    changes: await total(tables.changes),
    alerts: await total(tables.alerts),
    source_runs: await total(tables.sourceRuns),
  }
}

// ---- movement (the signal band) ---------------------------------------------

export const MOVEMENT_WINDOW_HOURS = 24

const AXIS_OF: Readonly<Record<string, keyof Omit<MovementSummary['recent'], 'total'>>> = {
  model: 'pricing',
  job: 'hiring',
  filing: 'sec',
  incident: 'incidents',
}

// Ranking rows are a daily time series, not events (~50 new rows a day by
// construction), so they are out of "what moved" entirely — the window's
// anchor included, or a ranking tick would pull the 24h window past a price
// change detected the day before. Same exclusion as the judge's pending
// query (server/pipeline/judge/pending.ts › JUDGE_EXCLUDED_ENTITY_TYPES).
const isEvent = () => ne(tables.changes.entity_type, 'ranking')

/**
 * Reported window: 24h back from the NEWEST detection, not from the reader's
 * clock. A terminal opened on Monday must still say what moved on Friday
 * rather than "nothing recently" — and the window's start ships with the
 * number so the claim is checkable. window_from is derived from the same
 * max() the counts filter on; the take-home once selected it per entity type
 * and reported a window it had not filtered on.
 */
export async function queryMovement(db: PipelineDb): Promise<MovementSummary> {
  const [bounds] = await db
    .select({ latest: max(tables.changes.detected_at), n: count() })
    .from(tables.changes)
    .where(isEvent())
  const totalChanges = bounds?.n ?? 0
  const latest = bounds?.latest ?? null

  const recent = { pricing: 0, hiring: 0, sec: 0, incidents: 0, total: 0 }
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
    .select({ source_id: tables.snapshots.source_id, n: count() })
    .from(tables.snapshots)
    .groupBy(tables.snapshots.source_id)

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
  if (entityType === 'ranking') {
    const tokens = num(payload.total_tokens)
    return `${str(payload.model_permaslug) ?? '?'} · ${str(payload.date) ?? '?'} · ${tokens === null ? '?' : countLabel(tokens)} tokens`
  }
  return entityType
}

const scalar = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : JSON.stringify(v)

/** Every field of either payload, sorted by name, with both sides as scalars. */
export function fieldTable(before: Json | null, after: Json | null): FieldDiff[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort(
    byString,
  )
  return keys.map((field) => ({
    field,
    before: before ? scalar(before[field]) : null,
    after: after ? scalar(after[field]) : null,
  }))
}

/** Fields whose value differs between the two payloads, sorted by name. */
export function fieldDiff(before: Json | null, after: Json | null): FieldDiff[] {
  if (!before || !after) return []
  return fieldTable(before, after).filter((d) => d.before !== d.after)
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
  const where = tierWhere(tier)
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
export const OVERVIEW_TICKER = 8

export async function queryOverview(db: PipelineDb, ctx: QueryContext): Promise<OverviewData> {
  const [movement, alerts, ticker, totals, stamps] = await Promise.all([
    queryMovement(db),
    queryAlerts(db, ctx, OVERVIEW_ALERTS, 'alert'),
    queryAlerts(db, ctx, OVERVIEW_TICKER, 'ticker'),
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
    ticker: ticker.rows,
    ticker_count: ticker.total,
    totals,
    latest_fetched_at: latest,
  }
}

// ---- prices ----------------------------------------------------------------

const MATRIX_TIER_NOTE =
  'List price on each vendor’s standard tier — batch, long-context, promo-window and cached-only rows are excluded (they are in the full catalog).'

const isStandardTier = (tier: string | null): boolean => tier === null || tier === 'standard'

const pricedRow = (r: PriceRowView) => r.input_per_mtok !== null || r.output_per_mtok !== null

/** Prefer a priced row, then the one carrying more price fields, then the newest fetch. */
function preferRow(a: PriceRowView, b: PriceRowView): number {
  const priced = Number(pricedRow(b)) - Number(pricedRow(a))
  if (priced !== 0) return priced
  const fields = (r: PriceRowView) =>
    Number(r.input_per_mtok !== null) +
    Number(r.cached_input_per_mtok !== null) +
    Number(r.output_per_mtok !== null)
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
    input_per_mtok: num(payload.input_per_mtok),
    cached_input_per_mtok: num(payload.cached_input_per_mtok),
    output_per_mtok: num(payload.output_per_mtok),
    effective_from: str(payload.effective_from),
    effective_until: str(payload.effective_until),
    notes: str(payload.notes),
    removed: false,
    delta: null,
    also_listed_by: [],
    source_url: base.source_url,
    fetched_at: base.fetched_at,
  }
}

/** Newest change per (entity_key, source_url) for model rows. */
async function newestModelChanges(db: PipelineDb) {
  const newest = db
    .select({
      entity_key: tables.changes.entity_key,
      source_url: tables.changes.source_url,
      at: max(tables.changes.detected_at).as('at'),
    })
    .from(tables.changes)
    .where(eq(tables.changes.entity_type, 'model'))
    .groupBy(tables.changes.entity_key, tables.changes.source_url)
    .as('newest_change')

  const rows = await db
    .select({ change: tables.changes })
    .from(tables.changes)
    .innerJoin(
      newest,
      and(
        eq(tables.changes.entity_key, newest.entity_key),
        eq(tables.changes.source_url, newest.source_url),
        eq(tables.changes.detected_at, newest.at),
      ),
    )
    .orderBy(asc(tables.changes.entity_key), asc(tables.changes.id))

  const out = new Map<string, typeof tables.changes.$inferSelect>()
  for (const { change } of rows) {
    const key = `${change.entity_key} ${change.source_url}`
    if (!out.has(key)) out.set(key, change)
  }
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

export async function queryPrices(db: PipelineDb, ctx: QueryContext): Promise<PricesData> {
  const [entities, changes, stamps] = await Promise.all([
    db.select().from(tables.entities).where(eq(tables.entities.entity_type, 'model')),
    newestModelChanges(db),
    sourceStamps(db),
  ])

  // One view per stored row, then collapse to one per SKU key.
  const byKey = new Map<string, PriceRowView[]>()
  for (const e of entities) {
    const payload = parseJson(e.payload)
    if (!payload || typeof payload.model_slug !== 'string') continue
    const row = priceRowFromPayload(e, payload)
    const change = changes.get(`${e.entity_key} ${e.source_url}`)
    if (change) row.delta = toDelta(change)
    const list = byKey.get(e.entity_key) ?? []
    list.push(row)
    byKey.set(e.entity_key, list)
  }

  const rows: PriceRowView[] = []
  for (const [, candidates] of byKey) {
    candidates.sort(preferRow)
    const [winner, ...rest] = candidates
    winner!.also_listed_by = rest.map((r) => r.source_id).sort(byString)
    rows.push(winner!)
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
    matrix: buildMatrix(rows),
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

/**
 * Joins the editorial class map (terminal-classes.ts) to real stored rows.
 * Nothing is computed about a model here: the map says which slug answers
 * which question, the store says what that slug costs, and anything the two
 * cannot answer becomes a stated gap.
 */
export function buildMatrix(rows: readonly PriceRowView[]): PriceMatrix {
  const bySlug = new Map<string, PriceRowView[]>()
  for (const row of rows) {
    if (row.removed || !isStandardTier(row.tier)) continue
    const key = `${row.provider}:${row.model_slug}`
    bySlug.set(key, [...(bySlug.get(key) ?? []), row])
  }

  const cells: MatrixCell[] = []
  for (const provider of PROVIDER_ORDER) {
    for (const klass of MODEL_CLASSES) {
      const entry = MODEL_CLASS_MAP.find((e) => e.provider === provider && e.class === klass.id)
      if (!entry) {
        const gap = CLASS_GAPS.find((g) => g.provider === provider && g.class === klass.id)
        cells.push({
          provider,
          class: klass.id,
          row: null,
          basis: null,
          basis_source_id: null,
          gap: gap?.reason ?? 'No mapping — the vendor publishes no recommendation to transcribe.',
          priced: false,
        })
        continue
      }
      // Never merge fields across sources: the cell's provenance is one row's.
      const row =
        (bySlug.get(`${provider}:${entry.model_slug}`) ?? []).slice().sort(preferRow)[0] ?? null
      const priced = row !== null && pricedRow(row)
      cells.push({
        provider,
        class: klass.id,
        row,
        basis: entry.basis,
        basis_source_id: entry.basis_source_id,
        gap: priced ? null : row ? (PRICE_GAPS[provider as BigFour] ?? NO_ROW_GAP) : NO_ROW_GAP,
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

export async function queryHiring(db: PipelineDb, ctx: QueryContext): Promise<HiringData> {
  const department = sql<string | null>`json_extract(${tables.entities.payload}, '$.department')`
  const company = sql<string | null>`json_extract(${tables.entities.payload}, '$.company_name')`
  const isJob = eq(tables.entities.entity_type, 'job')

  const [departments, companies, sources, stamps] = await Promise.all([
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

  const cut = ctx.registry.cuts.find((c) => c.id === 'google-hiring')
  const xaiCaveat = ctx.registry.sources.find((s) => s.source_id === 'xai-greenhouse')?.caveat

  const providers: HiringProviderView[] = []
  for (const provider of PROVIDER_ORDER) {
    if (provider === 'google') {
      // Honest cut — never a fabricated number (sources.yaml `cut.google-hiring`).
      providers.push({
        provider,
        display: PROVIDER_DISPLAY.google,
        feed: 'no_public_feed',
        reason: cut?.reason ?? 'No public hiring feed exists for Google.',
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
      .map((d) => ({ department: d.department ?? '(no department)', count: d.n }))
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
    const feedSources: HiringSource[] = HIRING_SOURCE_IDS[provider]
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
    provider: base.provider as BigFour,
    incident_id,
    title,
    impact: str(payload.impact) ?? '?',
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

  const feedStamps = Object.values(INCIDENT_SOURCE_IDS)
    .map((id) => stamps.get(id))
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

  const cut = ctx.registry.cuts.find((c) => c.id === 'xai-status')
  const providers: IncidentProviderView[] = []
  for (const provider of PROVIDER_ORDER) {
    if (provider === 'xai') {
      // Honest cut — never a fabricated zero (sources.yaml `cut.xai-status`).
      providers.push({
        provider,
        display: PROVIDER_DISPLAY.xai,
        feed: 'no_public_feed',
        reason: cut?.reason ?? 'No public status feed is reachable for xAI.',
        caveat: null,
        last_window: 0,
        prior_window: 0,
        open: [],
        coverage_from: null,
        sources: [],
      })
      continue
    }
    const sourceId = INCIDENT_SOURCE_IDS[provider]
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

// ---- coverage --------------------------------------------------------------

export async function queryCoverage(db: PipelineDb, ctx: QueryContext): Promise<CoverageData> {
  const [stamps, runs, counts, totals] = await Promise.all([
    sourceStamps(db),
    lastRuns(db),
    db
      .select({ source_id: tables.entities.source_id, n: count() })
      .from(tables.entities)
      .groupBy(tables.entities.source_id),
    tableCounts(db),
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
      // The manifest carries the resolved URL (query strings, the CIK) where
      // sources.yaml has a template.
      url: manifestFixtures.find((f) => f.source_id === source.source_id)?.source_url ?? source.url,
      newest_snapshot: stamp?.newest ?? null,
      snapshot_count: stamp?.snapshot_count ?? 0,
      last_run: runs.get(source.source_id) ?? null,
      entity_count: entityCount.get(source.source_id) ?? 0,
    }
  })

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
    totals,
    exports,
    latest_fetched_at: latest,
  }
}
