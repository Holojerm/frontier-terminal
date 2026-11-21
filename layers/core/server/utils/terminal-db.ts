// Read-only query layer over the pipeline tables — what every terminal page
// renders. The UI never writes: layers/core/server/pipeline/store.ts › insertRows() is
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
// This file holds what every axis shares: the query context, source reads,
// table counts, baselines, freshness and coverage. The axes have their own
// modules: terminal-alerts.ts, terminal-prices.ts, terminal-hiring.ts and
// terminal-incidents.ts.
//
// Every function takes the Drizzle client explicitly (the shape
// server/utils/fleet-status.ts uses) so layers/terminal/test/terminal-db.test.ts drives them
// against the workerd D1.

import { and, eq, inArray, max, min, sql } from 'drizzle-orm'
import { isSetLane } from '#server/registries/set-lanes'
import type { Prov, ProviderId, Stamp } from '../../shared/utils/terminal-types/common'
import type {
  CoverageData,
  RecipeCoverage,
  SnapshotStamp,
  SourceCoverage,
  SourceRunStamp,
  TableCounts,
} from '../../shared/utils/terminal-types/coverage'

import * as tables from '#server/db/schema'
import { READ_RUN_STATUSES } from '../db/tables/columns'
import { manifestFixtures } from '../pipeline/parsers/fixture-provenance'
import { QUERY_CONTEXT_BLOCKS, type QueryContextBlocks } from '#server/registries/query-context'
import { RECIPES } from '#server/registries/recipes'
import { countedTotals, countsByKey } from './row-counts'
import type { PipelineDb } from '../pipeline/store'
import type { DataFreshness } from '#server/utils/seo'
import { EXPORT_TABLES } from '#server/registries/export-tables'
import { historyRule } from './terminal-export-history'
import { sourceFailures, sourceHealth } from './source-health'
import {
  ENTITY_METHOD,
  pointInTimeNotes,
  rewindEntities,
  type PointInTimeNotes,
  type Rewound,
} from './terminal-asof'
import { byString } from './terminal-json'
import {
  PROVIDER_ORDER,
  DERIVED_TERMS_FROM,
  derivedTemplateOf,
  labelOf,
  readSourceRegistry,
  type SourceRegistry,
} from './terminal-sources'

/**
 * What every query needs beyond the client: the registry, the tick it reports,
 * and each sources.yaml block a domain reads (QueryContextBlocks, composed in
 * server/registries/query-context.ts).
 */
export interface QueryContext extends QueryContextBlocks {
  registry: SourceRegistry
  /** Newest source_runs.started_at, already read for the cache key — at or before `at` when one is set. */
  as_of: string | null
  now: () => Date
  /**
   * The instant a point-in-time request (`?as_of=`) asks about, or null for
   * now. A query that honours it must read every table as of that instant
   * (layers/core/server/utils/terminal-asof.ts); a route whose query
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
  const blocks = Object.fromEntries(
    Object.entries(QUERY_CONTEXT_BLOCKS).map(([name, read]) => [name, read(sourcesYaml)]),
  ) as QueryContextBlocks
  return {
    registry: readSourceRegistry(sourcesYaml),
    ...blocks,
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

export const atOf = (ctx: QueryContext): (QueryContext & { at: string }) | null =>
  ctx.at === null ? null : (ctx as QueryContext & { at: string })

/** An answer read from the Internet Archive: its method, and that it is event time (PointInTimeNotes). */
export function noteArchived(ctx: QueryContext, method: string): void {
  ctx.notes.method.add(method)
  ctx.notes.eventTime = true
}

/** The audit's reason for a sources.yaml cut, or null when the id is not registered. */
export const cutReason = (ctx: QueryContext, cutId: string): string | null =>
  ctx.registry.cuts.find((c) => c.id === cutId)?.reason ?? null

export const stampOf = (ctx: QueryContext): Stamp => ({
  as_of: ctx.as_of,
  computed_at: ctx.now().toISOString(),
})

export const PROVIDER_RANK: Readonly<Record<string, number>> = {
  openai: 0,
  anthropic: 1,
  google: 2,
  xai: 3,
  meta: 4,
  mistral: 5,
  deepseek: 6,
  alibaba: 7,
  moonshot: 8,
  other: 9,
}

// ---- snapshots and runs ------------------------------------------------------

export interface SourceStamp {
  source_id: string
  newest: SnapshotStamp
  /** Null in a point-in-time read: counting snapshots up to T reads every one of them. */
  snapshot_count: number | null
}

/** Every per-source stamp a payload cites, from one statement (sourceReads). */
export interface SourceReads {
  /** Newest snapshot per source, with how many that source has. The coverage panel reports these: fetches. */
  stamps: Map<string, SourceStamp>
  /**
   * The newest poll per source whose page was read into the store, as that
   * snapshot's fetched_at. A snapshot alone is not enough: a run can store the
   * bytes and then fail (a parser error, a refused mass removal), and the rows
   * are still the older page's.
   */
  reads: Map<string, string>
  /** Each source as a "data as of" citation: its newest read, or for a source never read, its newest snapshot. */
  cited: Map<string, Prov>
  /** Newest run per source — how the last poll of it ended. Empty as of an instant: source_stats only holds the current one. */
  runs: Map<string, SourceRunStamp>
}

/**
 * The newest snapshot, newest successful read and newest run of every source,
 * as of `at` or now, in one round trip. Driven from source_stats, one row per
 * source, so each correlated subquery is an index seek on
 * (source_id, fetched_at) or (source_id, started_at) rather than a scan of
 * tables that grow by a row per source per tick. Two rows in the same instant:
 * the larger id wins. The newest read seeks source_runs_read_idx, which holds
 * only the runs that read their page, so a source that keeps failing does not
 * cost a walk back through every failed run.
 *
 * Every subquery names its index. D1 keeps no planner statistics, and left to
 * choose, SQLite took the (fetched_at, id) and (started_at, id) indexes for
 * their ORDER BY: a tick starts every source in the same instant, so each
 * source's seek read the whole tick (13k rows a call in production, 3k named).
 */
export async function sourceReads(db: PipelineDb, at: string | null = null): Promise<SourceReads> {
  const newestSnapshot = at
    ? sql`(select s1.id from snapshots s1 indexed by snapshots_source_fetched_idx where s1.source_id = st.source_id and s1.fetched_at <= ${at} order by s1.fetched_at desc, s1.id desc limit 1)`
    : sql`(select s1.id from snapshots s1 indexed by snapshots_source_fetched_idx where s1.source_id = st.source_id and s1.fetched_at = st.last_fetched_at order by s1.id desc limit 1)`
  const newestRun = at
    ? sql`null`
    : sql`(select r1.id from source_runs r1 indexed by source_runs_source_started_idx where r1.source_id = st.source_id and r1.started_at = st.last_run_at order by r1.id desc limit 1)`
  const rows = await db.all<{
    source_id: string
    n: number
    source_url: string | null
    fetched_at: string | null
    http_status: number | null
    bytes: number | null
    read_at: string | null
    run_started_at: string | null
    run_status: string | null
    run_detail: string | null
    run_scope: string | null
    run_source_url: string | null
  }>(sql`select st.source_id as source_id, st.snapshot_count as n,
      s.source_url as source_url, s.fetched_at as fetched_at, s.http_status as http_status, s.bytes as bytes,
      (select s2.fetched_at from source_runs r2 indexed by source_runs_read_idx
        join snapshots s2 on s2.id = r2.snapshot_id
        where r2.source_id = st.source_id and r2.status in ${sql.raw(READ_RUN_STATUSES)}${at ? sql` and s2.fetched_at <= ${at}` : sql``}
        order by r2.started_at desc limit 1) as read_at,
      r.started_at as run_started_at, r.status as run_status, r.detail as run_detail,
      r.scope as run_scope, r.source_url as run_source_url
    from source_stats st
    left join snapshots s on s.id = ${newestSnapshot}
    left join source_runs r on r.id = ${newestRun}
    order by st.source_id`)

  const out: SourceReads = {
    stamps: new Map(),
    reads: new Map(),
    cited: new Map(),
    runs: new Map(),
  }
  for (const row of rows) {
    if (row.read_at) out.reads.set(row.source_id, row.read_at)
    if (row.fetched_at !== null && row.source_url !== null) {
      out.stamps.set(row.source_id, {
        source_id: row.source_id,
        newest: {
          source_url: row.source_url,
          fetched_at: row.fetched_at,
          http_status: row.http_status,
          bytes: row.bytes,
        },
        snapshot_count: at ? null : row.n,
      })
      out.cited.set(row.source_id, {
        source_url: row.source_url,
        fetched_at: row.read_at ?? row.fetched_at,
      })
    }
    if (row.run_started_at !== null) {
      out.runs.set(row.source_id, {
        started_at: row.run_started_at,
        status: row.run_status as SourceRunStamp['status'],
        detail: row.run_detail,
        scope: row.run_scope!,
        source_url: row.run_source_url!,
      })
    }
  }
  return out
}

/**
 * When a current row was last confirmed: its source's newest read, if later
 * than the row's own fetch. Only for a source whose stored set mirrors the
 * page ('set' lanes); an append-only feed keeps rows the page has dropped, so
 * a newer read of it confirms nothing about them.
 */
export function confirmedAt(
  reads: ReadonlyMap<string, string>,
  source_id: string,
  fetched_at: string,
): string | null {
  if (!isSetLane(source_id)) return null
  const read = reads.get(source_id)
  return read && Date.parse(read) > Date.parse(fetched_at) ? read : null
}

/** First snapshot per source — when watching it began. */
export async function firstSnapshotPerSource(
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

export async function tableCounts(db: PipelineDb): Promise<TableCounts> {
  // snapshots and source_runs from source_stats, the rest from row_counts:
  // count(*) reads every row.
  const [[logged], totals] = await Promise.all([
    db
      .select({
        snapshots: sql<number>`coalesce(sum(${tables.sourceStats.snapshot_count}), 0)`,
        source_runs: sql<number>`coalesce(sum(${tables.sourceStats.run_count}), 0)`,
      })
      .from(tables.sourceStats),
    countedTotals(db),
  ])
  return {
    snapshots: logged?.snapshots ?? 0,
    entities: totals.entities,
    changes: totals.changes,
    alerts: totals.alerts,
    source_runs: logged?.source_runs ?? 0,
  }
}

/**
 * The (source_url, fetched_at) pairs of every baseline fetch: the first
 * snapshot each source ever produced, plus any snapshot a source_runs row
 * marks 'baseline'. This Worker's baseline writes entities and no change
 * rows (layers/terminal/server/pipeline/refresh.ts), so the first form is what matters for
 * the history imported at the 2026-09-08 cutover — that build logged its
 * first Google parse as an `added` row per SKU, and those are first
 * sightings of a watcher, not of a model.
 */
export function baselineInstants(
  snapshots: readonly Pick<
    typeof tables.snapshots.$inferSelect,
    'id' | 'source_url' | 'fetched_at'
  >[],
  runs: readonly Pick<typeof tables.sourceRuns.$inferSelect, 'status' | 'snapshot_id'>[],
): Set<string> {
  const first = new Map<string, string>()
  for (const s of snapshots) {
    const seen = first.get(s.source_url)
    if (seen === undefined || Date.parse(s.fetched_at) < Date.parse(seen))
      first.set(s.source_url, s.fetched_at)
  }
  const out = new Set<string>()
  for (const [url, fetched] of first) out.add(`${url}\n${fetched}`)
  const byId = new Map(snapshots.map((s) => [s.id, s]))
  for (const run of runs) {
    if (run.status !== 'baseline' || !run.snapshot_id) continue
    const snap = byId.get(run.snapshot_id)
    if (snap) out.add(`${snap.source_url}\n${snap.fetched_at}`)
  }
  return out
}

/** Baseline (source_url, fetched_at) pairs: first snapshot per source, plus runs marked baseline. */
export async function loadBaselineInstants(db: PipelineDb): Promise<Set<string>> {
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
  // Driven from the registry's ids, one index seek per recipe on
  // (recipe_id, started_at) and (recipe_id, fetched_at). Driven from the
  // tables, the newest run and newest observation each read every row the
  // recipes have ever written.
  const ids = JSON.stringify(RECIPES.map((r) => r.id))
  const [runs, counts, newest] = await Promise.all([
    db.all<{
      recipe_id: string
      status: string
      started_at: string
      detail: string | null
      source_url: string
    }>(sql`select r.recipe_id as recipe_id, r.status as status, r.started_at as started_at,
        r.detail as detail, r.source_url as source_url
      from json_each(${ids}) ids
      join recipe_runs r on r.id = (select r1.id from recipe_runs r1
        where r1.recipe_id = ids.value order by r1.started_at desc limit 1)`),
    countsByKey(db, 'recipe_observations'),
    db.all<{ recipe_id: string; source_url: string; fetched_at: string }>(
      sql`select o.recipe_id as recipe_id, o.source_url as source_url, o.fetched_at as fetched_at
      from json_each(${ids}) ids
      join recipe_observations o on o.id = (select o1.id from recipe_observations o1
        where o1.recipe_id = ids.value order by o1.fetched_at desc limit 1)`,
    ),
  ])
  const runOf = new Map(runs.map((r) => [r.recipe_id, r]))
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
      observations: counts.get(recipe.id) ?? 0,
      newest: stored ? { source_url: stored.source_url, fetched_at: stored.fetched_at } : null,
      caveat: audit?.caveat ?? null,
      terms: audit?.terms ?? null,
      rights: audit?.rights ?? null,
    }
  })
}

export async function queryCoverage(db: PipelineDb, ctx: QueryContext): Promise<CoverageData> {
  const [{ stamps, runs }, counts, totals, [first]] = await Promise.all([
    sourceReads(db),
    countsByKey(db, 'entities'),
    tableCounts(db),
    db.select({ at: min(tables.sourceStats.first_fetched_at) }).from(tables.sourceStats),
  ])
  const entityCount = counts

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
      health: null,
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
      health: null,
      entity_count: entityCount.get(source_id) ?? 0,
      derived_from: template,
    })
  }

  // Degraded sources, judged as of the newest check of any source so the
  // verdict is the same however long the response sits in cache.
  const asOf = [...runs.values()].reduce<string | null>(
    (newest, r) => (newest === null || r.started_at > newest ? r.started_at : newest),
    null,
  )
  if (asOf) {
    const failingNow = sources
      .filter((s) => s.last_run?.status === 'failed')
      .map((s) => s.source_id)
    const { failures, since } = await sourceFailures(db, failingNow, asOf)
    for (const s of sources) {
      s.health = sourceHealth(
        s.last_run,
        failures.get(s.source_id) ?? 0,
        since.get(s.source_id) ?? null,
        asOf,
      )
    }
  }

  const exports = await Promise.all(
    Object.values(EXPORT_TABLES).map(async (table) => ({
      name: table.name,
      description: table.description,
      columns: [...table.columns],
      rows: await table.count(db),
      history: historyRule(table.name).kind,
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

/** Ascending by time, then id, so output order never depends on input order. */
export function byDetectedAt(
  a: typeof tables.changes.$inferSelect,
  b: typeof tables.changes.$inferSelect,
): number {
  return Date.parse(a.detected_at) - Date.parse(b.detected_at) || byString(a.id, b.id)
}

/** A change row carries no source_id; recover it from the audited URL. */
export function sourceIdForUrl(url: string, ctx: QueryContext): string {
  return (
    manifestFixtures.find((f) => f.source_url === url)?.source_id ??
    ctx.registry.sources.find((s) => s.url === url)?.source_id ??
    '(unknown source)'
  )
}
