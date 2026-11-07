// The price catalog and matrix, one SKU's history, the SKU keys the sitemap
// lists, and model releases.

import { and, eq, max, min, sql } from 'drizzle-orm'
import type {
  LabId,
  MatrixCell,
  PriceDeltaView,
  PriceHistoryData,
  PriceMatrix,
  PriceRowView,
  PricesData,
  ProviderId,
  ReleasesData,
} from '../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import { manifestFixtures } from '../pipeline/parsers/fixture-provenance'
import { effectiveClassMap } from '../pipeline/class-map'
import type { PipelineDb } from '../pipeline/store'
import {
  BASIS_STALE_NOTE,
  CLASS_GAPS,
  MODEL_CLASSES,
  MODEL_CLASS_MAP,
  NO_ROW_GAP,
  PRICE_GAPS,
  type ClassEntry,
} from './terminal-classes'
import {
  ARCHIVED_AS_OF_METHOD,
  ARCHIVED_LABS_AS_OF_METHOD,
  archivedCatalogAt,
  archivedPriceKeys,
  archivedRowsForKey,
  beforeLiveFloor,
  labLiveFloors,
  labsBeforeFloor,
  queryPriceReach,
} from './terminal-archive'
import {
  archivedPriceHistory,
  byDetectedAt,
  dayOf,
  priceHistory,
  releaseEvents,
  sparkOf,
} from './terminal-history'
import { byString, num, parseJson, str, type Json } from './terminal-json'
import { PROVIDER_ORDER, labelOf } from './terminal-sources'
import {
  PROVIDER_RANK,
  atOf,
  confirmedAt,
  firstSnapshotPerSource,
  loadBaselineInstants,
  noteArchived,
  rewound,
  sourceReads,
  stampOf,
  type QueryContext,
} from './terminal-db'

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
    checked_at: null,
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
    cached_before: before ? num(before.cached_input_per_mtok) : null,
    cached_after: after ? num(after.cached_input_per_mtok) : null,
    source_url: change.source_url,
    fetched_at: change.fetched_at,
  }
}

const PRICES_METHOD =
  'The like-for-like matrix maps classes with the hand-transcribed class map in today’s code, overlaid with the judge’s class-map decisions made by as_of.'

export async function queryPrices(db: PipelineDb, ctx: QueryContext): Promise<PricesData> {
  const pit = atOf(ctx)
  if (pit && (await beforeLiveFloor(db, pit.at))) return archivedPrices(db, pit)
  const models = pit ? rewound(db, pit, 'model') : null
  if (pit) ctx.notes.method.add(PRICES_METHOD)
  const [entities, history, { stamps, reads }, firsts, checks, classMap, reach, early] =
    await Promise.all([
      models
        ? models.then((m) => m.rows)
        : db.select().from(tables.entities).where(eq(tables.entities.entity_type, 'model')),
      models ? models.then((m) => m.changes) : modelChanges(db),
      sourceReads(db, ctx.at),
      firstSnapshotByUrl(db),
      pit
        ? rewound(db, pit, 'recommendation').then((r) => r.rows)
        : db
            .select()
            .from(tables.entities)
            .where(eq(tables.entities.entity_type, 'recommendation')),
      effectiveClassMap(db, ctx.at),
      queryPriceReach(db, ctx.registry),
      pit ? archivedBeforeOwnFloor(db, pit) : null,
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
      checked_at: confirmedAt(reads, from.source_id, from.fetched_at),
    }
  }
  for (const r of rows) {
    if (!r.removed) r.checked_at = confirmedAt(reads, r.source_id, r.fetched_at)
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

  // The matrix maps live rows only, so it is built before archived rows join.
  const matrix = buildMatrix(
    rows,
    basisChecks(checks, reads),
    classMap,
    ctx.at ?? ctx.now().toISOString(),
  )
  if (early) rows.push(...early.filter((r) => !byKey.has(r.entity_key)))

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
    matrix,
    counts: {
      total: rows.length,
      priced: rows.filter((r) => !r.removed && pricedRow(r)).length,
      catalog_only: rows.filter((r) => !r.removed && !pricedRow(r)).length,
      removed: rows.filter((r) => r.removed).length,
    },
    changes_available: changes.size > 0,
    reach,
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

/**
 * As of T after the first fetch, the labs whose own pricing pages were not
 * fetched yet: their rows from the newest readable archive capture by T, so
 * a lab added later is answered from the archive up to its own first fetch
 * rather than missing. Null when every lab's live record had begun.
 */
async function archivedBeforeOwnFloor(
  db: PipelineDb,
  ctx: QueryContext & { at: string },
): Promise<PriceRowView[] | null> {
  const floors = await labLiveFloors(db, ctx.registry, 'pricing')
  const labs = labsBeforeFloor(floors, ctx.at, 'pricing')
  if (labs.length === 0) return null
  const catalog = await archivedCatalogAt(db, ctx.at, labs)
  if (catalog.rows.length === 0) return null
  noteArchived(ctx, ARCHIVED_LABS_AS_OF_METHOD)
  for (const c of catalog.captures) {
    ctx.notes.method.add(
      `${c.provider}: Internet Archive capture of ${c.captured_at} (${c.source_url}).`,
    )
  }
  return catalog.rows
}

/**
 * /api/prices as of an instant before this site's first fetch: each lab's
 * price list from its newest readable Internet Archive capture by then
 * (terminal-archive.ts). The matrix maps today's classes, which name no
 * archived-era model, so it is built over no rows and every cell says so.
 */
async function archivedPrices(
  db: PipelineDb,
  ctx: QueryContext & { at: string },
): Promise<PricesData> {
  const [catalog, reach] = await Promise.all([
    archivedCatalogAt(db, ctx.at),
    queryPriceReach(db, ctx.registry),
  ])
  noteArchived(ctx, ARCHIVED_AS_OF_METHOD)
  for (const c of catalog.captures) {
    ctx.notes.method.add(
      `${c.provider}: Internet Archive capture of ${c.captured_at} (${c.source_url}).`,
    )
  }
  const rows = catalog.rows.sort((a, b) => {
    const p = (PROVIDER_RANK[a.provider] ?? 9) - (PROVIDER_RANK[b.provider] ?? 9)
    if (p !== 0) return p
    if (a.model_slug !== b.model_slug) return byString(a.model_slug, b.model_slug)
    return byString(a.tier ?? '', b.tier ?? '')
  })
  return {
    ...stampOf(ctx),
    rows,
    matrix: buildMatrix([]),
    counts: {
      total: rows.length,
      priced: rows.filter(pricedRow).length,
      catalog_only: rows.filter((r) => !pricedRow(r)).length,
      removed: 0,
    },
    changes_available: false,
    reach,
    cross_check: null,
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

/**
 * Stored 'recommendation' entities as checks, keyed by provider:class. An
 * entity's fetched_at only moves when its verdict changes, but every read of
 * the page re-checks it, so with `reads` (sourceReads) the check is dated to
 * the source's newest read.
 */
export function basisChecks(
  entities: readonly (typeof tables.entities.$inferSelect)[],
  reads: ReadonlyMap<string, string> = new Map(),
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
      fetched_at: confirmedAt(reads, e.source_id, e.fetched_at) ?? e.fetched_at,
    })
  }
  return out
}

/**
 * A scheduled price ("$Y starting Jan 1, 2027") is stored as its own row with
 * the same slug and a standard tier; only its key carries the start date
 * (normalize.ts › priceTier). Until that date it is not what the model costs,
 * the same rule spend's matchSku applies by preferring a current row.
 */
function scheduledAfter(row: PriceRowView, at: string | null): boolean {
  if (at === null || row.effective_from === null) return false
  const from = Date.parse(row.effective_from)
  return Number.isFinite(from) && from > Date.parse(at)
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
  /** The instant the matrix prices: a scheduled price that starts after it is not yet the price. */
  at: string | null = null,
): PriceMatrix {
  const bySlug = new Map<string, PriceRowView[]>()
  for (const row of rows) {
    if (row.removed || !isStandardTier(row.tier) || scheduledAfter(row, at)) continue
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
  // Archived points stop where live observation of this SKU's lab starts: a
  // capture the Archive took after our first fetch of the lab's pricing pages
  // adds nothing we did not see ourselves. Per lab, not the store's first
  // fetch, or a lab added later loses its archive up to its own first fetch.
  const lab = key.split(':')[1] as LabId
  const liveFrom = (await labLiveFloors(db, ctx.registry, 'pricing')).get(lab) ?? null
  const cut = ctx.at !== null && (liveFrom === null || ctx.at < liveFrom) ? ctx.at : liveFrom
  const archivedRows = (await archivedRowsForKey(db, key, cut)).filter(
    (r) => liveFrom === null || r.captured_at < liveFrom,
  )
  const archived = archivedPriceHistory(archivedRows)
  if (entities.length === 0 && changes.length === 0 && archived.length === 0) return null
  if (ctx.at !== null && archived.length > 0 && (liveFrom === null || ctx.at < liveFrom)) {
    noteArchived(ctx, ARCHIVED_AS_OF_METHOD)
  }

  const points = [
    ...archived,
    ...priceHistory(
      entities,
      changes,
      (url) => sourceIdForUrl(url, ctx),
      (url) => firsts.get(url) ?? null,
    ),
  ]
  // Identity fields from the newest payload on record.
  const newest = [...changes].sort(byDetectedAt).at(-1)
  const payload =
    parseJson(entities[0]?.payload ?? null) ??
    parseJson(newest?.after_json ?? null) ??
    parseJson(newest?.before_json ?? null) ??
    parseJson(archivedRows.at(-1)?.payload ?? null)
  const provider = (entities[0]?.provider ??
    newest?.provider ??
    key.split(':')[1] ??
    'other') as ProviderId
  return {
    ...stampOf(ctx),
    entity_key: key,
    provider,
    model_slug: str(payload?.model_slug) ?? '?',
    tier: str(payload?.tier),
    context_window: str(payload?.context_window),
    points,
    removed: entities.length === 0 && newest?.change_type === 'removed',
    archive_only: points.length > 0 && points.every((p) => p.basis === 'archived'),
  }
}

/**
 * Every SKU on record with its newest observation. `history` is whether the key
 * has a revision or an archived capture, i.e. whether its page shows more than
 * one price. A listing alone ('added') is still one price.
 */
export async function queryPriceKeys(
  db: PipelineDb,
): Promise<{ entity_key: string; lastmod: string; history: boolean }[]> {
  const [current, logged, archived] = await Promise.all([
    db
      .select({ entity_key: tables.entities.entity_key, at: max(tables.entities.fetched_at) })
      .from(tables.entities)
      .where(eq(tables.entities.entity_type, 'model'))
      .groupBy(tables.entities.entity_key),
    db
      .select({
        entity_key: tables.changes.entity_key,
        at: max(tables.changes.detected_at),
        revisions: sql<number>`sum(case when ${tables.changes.change_type} = 'modified' then 1 else 0 end)`,
      })
      .from(tables.changes)
      .where(eq(tables.changes.entity_type, 'model'))
      .groupBy(tables.changes.entity_key),
    archivedPriceKeys(db),
  ])
  const newest = new Map<string, string>()
  for (const row of [...current, ...logged, ...archived]) {
    if (!row.at) continue
    const seen = newest.get(row.entity_key)
    if (!seen || Date.parse(row.at) > Date.parse(seen)) newest.set(row.entity_key, row.at)
  }
  const withHistory = new Set([
    ...logged.filter((row) => Number(row.revisions) > 0).map((row) => row.entity_key),
    ...archived.map((row) => row.entity_key),
  ])
  return [...newest]
    .map(([entity_key, at]) => ({
      entity_key,
      lastmod: dayOf(at),
      history: withHistory.has(entity_key),
    }))
    .sort((a, b) => byString(a.entity_key, b.entity_key))
}

/**
 * The SKU pages worth a crawler's budget. A base SKU (`model:<lab>:<slug>`) is
 * always listed: it is the page that answers "what does <model> cost". A tier
 * variant (`…:batch`, `…:flex`, `…:priority`) is listed once its price has a
 * history; until then its page is the base page's table with one cell changed,
 * and ~450 of those would make templated near-duplicates most of the sitemap.
 * Unlisted pages stay indexable and linked; they are just not advertised.
 */
export function sitemapPriceKeys<T extends { entity_key: string; history: boolean }>(
  skus: T[],
): T[] {
  return skus.filter((sku) => sku.history || sku.entity_key.split(':').length <= 3)
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
