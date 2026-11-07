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
// This file holds what every axis shares: the query context, source reads,
// table counts, baselines, freshness and coverage. The axes have their own
// modules: terminal-alerts.ts, terminal-prices.ts, terminal-hiring.ts and
// terminal-incidents.ts.
//
// Every function takes the Drizzle client explicitly (the shape
// server/utils/fleet-status.ts uses) so layers/terminal/test/terminal-db.test.ts drives them
// against the workerd D1.

import { and, count, eq, inArray, max, min, sql } from 'drizzle-orm'
import { isSetLane } from '../pipeline/lane-removals'
import type {
  CoverageData,
  RecipeCoverage,
  Prov,
  ProviderId,
  SnapshotStamp,
  SourceCoverage,
  SourceRunStamp,
  Stamp,
  TableCounts,
} from '../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import { manifestFixtures } from '../pipeline/parsers/fixture-provenance'
import { parseDerivedSourcesBlock, type DerivedTemplate } from '../pipeline/derived'
import { parseRevenueFilersBlock, type RevenueFilers } from '../pipeline/parsers/sec/revenue-filers'
import { parseCikWhitelistBlock, type CikWhitelist } from '../pipeline/parsers/sec/whitelist'
import { RECIPES } from '../theses/recipes/registry'
import type { PipelineDb } from '../pipeline/store'
import type { DataFreshness } from '#server/utils/seo'
import { parseDepartmentClusters, type DepartmentCluster } from './terminal-clusters'
import { EXPORT_TABLES } from './terminal-export'
import { historyRule } from './terminal-export-history'
import {
  ENTITY_METHOD,
  pointInTimeNotes,
  rewindEntities,
  type PointInTimeNotes,
  type Rewound,
} from './terminal-asof'
import { baselineInstants } from './terminal-history'
import { byString } from './terminal-json'
import {
  PROVIDER_ORDER,
  DERIVED_TERMS_FROM,
  derivedTemplateOf,
  labelOf,
  readFiledFactSources,
  readSourceRegistry,
  type FiledFactSourceEntry,
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
  /** sources.yaml filed_fact_sources — the hyperscalers the exposure series read. */
  filedFactSources: (FiledFactSourceEntry & { cik: string })[]
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
  const whitelist = parseCikWhitelistBlock(sourcesYaml)
  return {
    registry: readSourceRegistry(sourcesYaml),
    clusters: parseDepartmentClusters(sourcesYaml),
    revenueFilers: parseRevenueFilersBlock(sourcesYaml),
    whitelist,
    derivedTemplates: parseDerivedSourcesBlock(sourcesYaml),
    filedFactSources: readFiledFactSources(sourcesYaml, whitelist),
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
 * the larger id wins.
 */
export async function sourceReads(db: PipelineDb, at: string | null = null): Promise<SourceReads> {
  const newestSnapshot = at
    ? sql`(select s1.id from snapshots s1 where s1.source_id = st.source_id and s1.fetched_at <= ${at} order by s1.fetched_at desc, s1.id desc limit 1)`
    : sql`(select s1.id from snapshots s1 where s1.source_id = st.source_id and s1.fetched_at = st.last_fetched_at order by s1.id desc limit 1)`
  const newestRun = at
    ? sql`null`
    : sql`(select r1.id from source_runs r1 where r1.source_id = st.source_id and r1.started_at = st.last_run_at order by r1.id desc limit 1)`
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
      (select s2.fetched_at from source_runs r2 join snapshots s2 on s2.id = r2.snapshot_id
        where r2.source_id = st.source_id and r2.status in ('ok', 'unchanged', 'baseline')${at ? sql` and s2.fetched_at <= ${at}` : sql``}
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
  const o = tables.recipeObservations
  // A join on each recipe's max, not a correlated subquery per row: the
  // subquery form re-scanned the recipe for every observation (n² per recipe).
  const latest = db
    .select({ recipe_id: o.recipe_id, at: max(o.fetched_at).as('latest_at') })
    .from(o)
    .groupBy(o.recipe_id)
    .as('latest')
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
        recipe_id: o.recipe_id,
        source_url: o.source_url,
        fetched_at: o.fetched_at,
      })
      .from(o)
      .innerJoin(latest, and(eq(o.recipe_id, latest.recipe_id), eq(o.fetched_at, latest.at))),
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
  const [{ stamps, runs }, counts, totals, [first]] = await Promise.all([
    sourceReads(db),
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
