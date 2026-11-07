// Open roles by lab and department, now and as a daily history.

import { count, eq, max, min, sql } from 'drizzle-orm'
import type {
  ArchivedHiringPoint,
  LabId,
  DeptCount,
  HiringData,
  HiringHistoryData,
  HiringHistoryProvider,
  HiringProviderView,
  HiringSource,
} from '../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../pipeline/store'
import { clusterSeries } from './terminal-clusters'
import { HIRING_ARCHIVE_CAVEATS, type HiringArchiveProvider } from '../pipeline/archive/hiring-eras'
import {
  ARCHIVED_HIRING_AS_OF_METHOD,
  ARCHIVED_LAB_BOARDS_AS_OF_METHOD,
  HIRING_ARCHIVE_METHOD,
  archivedHiringPoints,
  queryHiringReach,
  beforeLiveFloor,
  labLiveFloors,
  labsBeforeFloor,
} from './terminal-archive'
import {
  byDetectedAt,
  compareWindow,
  dailyInstants,
  dayOf,
  departmentSeries,
  NO_DEPARTMENT,
  openRolesAt,
  type OpenRole,
} from './terminal-history'
import { byString, parseJson, str } from './terminal-json'
import { HIRING_SOURCES, PROVIDER_DISPLAY, PROVIDER_ORDER, labelOf } from './terminal-sources'
import {
  atOf,
  confirmedAt,
  cutReason,
  noteArchived,
  rewound,
  sourceReads,
  stampOf,
  type QueryContext,
} from './terminal-db'

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
  ]
> {
  const jobs = await rewound(db, ctx, 'job')
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
  return [[...departments.values()], [...companies.values()], [...sources.values()]]
}

export async function queryHiring(db: PipelineDb, ctx: QueryContext): Promise<HiringData> {
  const department = sql<string | null>`json_extract(${tables.entities.payload}, '$.department')`
  const company = sql<string | null>`json_extract(${tables.entities.payload}, '$.company_name')`
  const isJob = eq(tables.entities.entity_type, 'job')

  const pit = atOf(ctx)
  if (pit && (await beforeLiveFloor(db, pit.at))) return archivedHiring(db, pit)
  const reading = sourceReads(db, ctx.at)
  const [departments, companies, sources] = pit
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
      ])

  const { reads, cited } = await reading
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

    // The counts are the whole board as of its last read, so they cite that
    // read. The newest job row's fetched_at only says when a role last
    // changed, which on a quiet board is days before the read that counted it.
    const rowSources: HiringSource[] = sources
      .filter((s) => s.provider === provider && s.fetched_at)
      .map((s) => ({
        source_id: s.source_id,
        label: labelOf(s.source_id).label,
        source_url: s.source_url,
        fetched_at: confirmedAt(reads, s.source_id, s.fetched_at!) ?? s.fetched_at!,
      }))
    // No rows yet: cite the feed's last read, or its newest snapshot if never read.
    const feedSources: HiringSource[] = backing.source_ids
      .map((id) => {
        const stamp = cited.get(id)
        return stamp ? { source_id: id, label: labelOf(id).label, ...stamp } : null
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

  // As of T, a lab whose board we had not read yet is answered from its
  // newest archived copy by T rather than as an empty board.
  if (pit) {
    const early = labsBeforeFloor(await labLiveFloors(db, ctx.registry, 'hiring'), pit.at, 'hiring')
    const points = early.length ? await archivedHiringPoints(db, ctx.clusters, pit.at) : null
    for (const lab of early) {
      if (!points?.get(lab)?.length) continue
      noteArchived(ctx, ARCHIVED_LAB_BOARDS_AS_OF_METHOD)
      const i = providers.findIndex((p) => p.provider === lab)
      providers[i] = archivedHiringView(pit, lab, points)
    }
  }

  return { ...stampOf(ctx), providers }
}

/**
 * /api/hiring as of an instant before this site first read the boards: each
 * lab's open roles on its newest readable Internet Archive copy by then
 * (terminal-archive.ts). A copy that states only the board's total has no
 * department rows; the method note says so.
 */
async function archivedHiring(
  db: PipelineDb,
  ctx: QueryContext & { at: string },
): Promise<HiringData> {
  const points = await archivedHiringPoints(db, ctx.clusters, ctx.at)
  noteArchived(ctx, ARCHIVED_HIRING_AS_OF_METHOD)
  const providers = PROVIDER_ORDER.map((provider) => archivedHiringView(ctx, provider, points))
  return { ...stampOf(ctx), providers }
}

/** One lab's board as of ctx.at from its newest readable archived copy, noted on point_in_time. */
function archivedHiringView(
  ctx: QueryContext & { at: string },
  provider: LabId,
  points: ReadonlyMap<string, ArchivedHiringPoint[]>,
): HiringProviderView {
  const backing = HIRING_SOURCES[provider]
  const newest = points.get(provider)?.at(-1)
  if (newest) {
    ctx.notes.method.add(
      `${provider}: Internet Archive copy of ${newest.at} (${newest.source_url}).`,
    )
  }
  return {
    provider,
    display: PROVIDER_DISPLAY[provider],
    feed: 'cut_id' in backing ? 'no_public_feed' : newest ? 'ok' : 'no_rows',
    reason:
      'cut_id' in backing
        ? (cutReason(ctx, backing.cut_id) ??
          `No public hiring feed exists for ${PROVIDER_DISPLAY[provider]}.`)
        : null,
    total: newest?.total ?? 0,
    departments: (newest?.departments ?? []).map((d) => ({
      department: d.department,
      count: d.open_roles,
    })),
    caveat: null,
    company_names: [],
    sources: newest
      ? [
          {
            source_id: newest.source_id,
            label: 'Internet Archive copy of the job board',
            source_url: newest.source_url,
            fetched_at: newest.fetched_at,
          },
        ]
      : [],
  }
}

// ---- hiring history --------------------------------------------------------

export const HIRING_WINDOW_DAYS = 30

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
  const [roles, changes, firstSnapshots, baselines, stamps, archived, reach] = await Promise.all([
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
    sourceReads(db, ctx.at).then((r) => r.cited),
    archivedHiringPoints(db, ctx.clusters, ctx.at),
    queryHiringReach(db, ctx.registry),
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
        archived: [],
        archive_caveat: null,
      })
      continue
    }
    const [primary, join] = backing.source_ids as [string, string | undefined]
    const from = firstOf.get(primary) ?? null
    const own = from ? grid.filter((g) => g.date >= dayOf(from)) : []
    const { total, departments } = departmentSeries(byInstant, own, provider)
    const dates = own.map((g) => g.date)
    // The series runs to the boards' last read, so that read is what it cites.
    const sources: HiringSource[] = backing.source_ids
      .map((id) => {
        const stamp = stamps.get(id)
        return stamp ? { source_id: id, label: labelOf(id).label, ...stamp } : null
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
      // Only the copies from before the live series starts: after it, the live board is the record.
      archived: (archived.get(provider) ?? []).filter((p) => from === null || p.at < from),
      archive_caveat: HIRING_ARCHIVE_CAVEATS[provider as HiringArchiveProvider] ?? null,
    })
  }

  return {
    ...stampOf(ctx),
    window_days: HIRING_WINDOW_DAYS,
    providers,
    reach,
    archive_method: HIRING_ARCHIVE_METHOD,
    log: {
      changes: sorted.length,
      from: sorted[0]?.detected_at ?? null,
      to: sorted.at(-1)?.detected_at ?? null,
    },
  }
}
