// The movement band, the alert feed and its permalinks, and the overview
// that leads with both.

import { and, asc, count, desc, eq, gt, inArray, lt, max, ne, or, sql } from 'drizzle-orm'

import { ENTITY_AXIS, entityTypesOf, type AlertAxis } from '../../shared/utils/terminal-labs'

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
  ChangeDetailView,
  ChangeView,
  MovementSummary,
  OverviewData,
  ProviderId,
} from '../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../pipeline/store'
import { ALERTS_METHOD, alertsKnownAt, judgeCutoffAt } from './terminal-asof'
import { byString, fieldDiff, fieldTable, num, parseJson, str, type Json } from './terminal-json'
import { sourceReads, stampOf, tableCounts, type QueryContext } from './terminal-db'

// ---- movement (the signal band) ---------------------------------------------

export const MOVEMENT_WINDOW_HOURS = 24

type BandAxis = keyof Omit<MovementSummary['recent'], 'total'>

// The band has no revenue bucket: revenue is read off the filings the SEC
// bucket counts. Rankings are not events (isEvent below).
const BAND_OF: Readonly<Record<AlertAxis, BandAxis | null>> = {
  pricing: 'pricing',
  hiring: 'hiring',
  sec: 'sec',
  revenue: 'sec',
  incidents: 'incidents',
  disclosures: 'disclosures',
  demand: null,
}

/**
 * The band bucket of each change entity type, derived from the shared axis
 * map so a new entity type is counted on an axis the moment it has one. A
 * hand-kept copy here missed six SEC types, and the band's total counted
 * changes no axis showed.
 */
export const AXIS_OF: Readonly<Record<string, BandAxis>> = Object.fromEntries(
  Object.entries(ENTITY_AXIS).flatMap(([type, axis]) => {
    const band = BAND_OF[axis]
    return band ? [[type, band]] : []
  }),
)

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
    // The total is the sum of the axes the band prints, never more.
    for (const row of inWindow) {
      const axis = AXIS_OF[row.entity_type]
      if (!axis) continue
      recent[axis] += row.n
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

export interface AlertFilter {
  /** Alerts citing at least one row from this lab. */
  lab?: ProviderId
  /** Alerts citing at least one row on this axis. */
  topic?: AlertAxis
  /** A `next_cursor` from the previous page: only alerts older than it. */
  cursor?: AlertCursor
}

/** Where a page ended, in the list's own order: created_at descending, then id ascending. */
export interface AlertCursor {
  created_at: string
  id: string
}

// `~` appears in neither an ISO timestamp nor a content-hash id, so it splits a cursor unambiguously.
export const formatAlertCursor = (c: AlertCursor): string => `${c.created_at}~${c.id}`

export function parseAlertCursor(text: string): AlertCursor | null {
  const [created_at, id, extra] = text.split('~')
  return created_at && id && extra === undefined ? { created_at, id } : null
}

/**
 * Lab and topic are not columns on an alert: they are read off the rows it
 * cites (terminal-labs.ts), so the filter does the same in SQL, over the
 * change_ids JSON array. "Any cited row matches", like alertLabs: an alert
 * citing two labs is found under both.
 */
function citesWhere(filter: AlertFilter) {
  if (!filter.lab && !filter.topic) return undefined
  const conds = [sql`c.id = j.value`]
  if (filter.lab) conds.push(sql`c.provider = ${filter.lab}`)
  if (filter.topic) {
    const types = entityTypesOf(filter.topic)
    conds.push(
      sql`c.entity_type in (${sql.join(
        types.map((t) => sql`${t}`),
        sql`, `,
      )})`,
    )
  }
  return sql`exists (select 1 from json_each(${tables.alerts.change_ids}) j join ${tables.changes} c on ${sql.join(conds, sql` and `)})`
}

const olderThan = (c: AlertCursor) =>
  or(
    lt(tables.alerts.created_at, c.created_at),
    and(eq(tables.alerts.created_at, c.created_at), gt(tables.alerts.id, c.id)),
  )

export async function queryAlerts(
  db: PipelineDb,
  ctx: QueryContext,
  limit: number,
  tier: AlertTierFilter = 'all',
  filter: AlertFilter = {},
): Promise<AlertsData> {
  let where = and(tierWhere(tier), citesWhere(filter))
  if (ctx.at !== null) {
    where = and(where, alertsKnownAt(ctx.at, await judgeCutoffAt(db, ctx.at)))
    ctx.notes.method.add(ALERTS_METHOD)
  }
  // One extra row says whether an older page exists without a second query.
  const fetched = await db
    .select()
    .from(tables.alerts)
    .where(filter.cursor ? and(where, olderThan(filter.cursor)) : where)
    .orderBy(desc(tables.alerts.created_at), asc(tables.alerts.id))
    .limit(limit + 1)
  const rows = fetched.slice(0, limit)
  const last = rows.at(-1)
  const next_cursor = fetched.length > limit && last ? formatAlertCursor(last) : null
  const [totalRow] = await db.select({ total: count() }).from(tables.alerts).where(where)
  const views = await resolveAlerts(db, rows, toChangeView)
  return { ...stampOf(ctx), tier, rows: views, total: totalRow?.total ?? 0, next_cursor }
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
  const [movement, alerts, info, totals, reads] = await Promise.all([
    queryMovement(db),
    queryAlerts(db, ctx, OVERVIEW_ALERTS, 'alert'),
    queryAlerts(db, ctx, OVERVIEW_INFO, 'info'),
    tableCounts(db),
    sourceReads(db).then((r) => r.reads),
  ])
  // "Last checked" is the newest read, not the newest snapshot: a fetch that
  // stored bytes and then failed to parse checked nothing.
  const latest = [...reads.values()].sort(byString).at(-1) ?? null
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
