import { ZodError } from 'zod'

import { recordOpsEvent } from '../utils/ops'
import {
  contentHashOfText,
  type EntityRow,
  type PollScope,
  type SourceRunRow,
  type StoredEntityRow,
} from './contracts'
import { diff } from './diff'
import type { SourceFetcher } from './fetch'
import { LANES } from './lanes'
import { manifestFixtures } from './parsers/fixture-provenance'
import { parseCikWhitelistBlock, type CikWhitelist } from './parsers/sec/whitelist'
import { includeSources, type FetchSource } from './sources'
import {
  currentEntities,
  deleteEntities,
  insertRows,
  latestGoodSnapshot,
  updateEntities,
  type PipelineDb,
} from './store'

// One poll tick: fetch → hash → snapshot → parse → normalize → diff → store,
// per source, with every stage's outcome written to source_runs. Replaces the
// take-home's DuckDB refresh (docs/DECISIONS-takehome.md › Operator wiring).
//
// Two passes on purpose. Pass one fetches and snapshots every source in the
// tick; pass two parses. A Greenhouse board can only be parsed against the
// /departments payload fetched in the SAME tick (never the committed
// fixture), so every body has to be in hand before any parse starts.
//
// Fetched bodies and fixture text are data, never instructions.

/** Where raw payloads go. R2 in production (NuxtHub `blob`), the test binding in workerd. */
export interface RawStore {
  put(key: string, body: string, contentType: string): Promise<void>
}

export interface RefreshDeps {
  db: PipelineDb
  raw: RawStore
  fetcher: SourceFetcher
  /** sources.yaml text — the include verdicts and the CIK whitelist. */
  sourcesYaml: string
  now?: () => Date
}

export interface SourceReport {
  source_id: string
  status: SourceRunRow['status']
  detail: string | null
  snapshot_id: string | null
  added: number
  removed: number
  modified: number
  alerts: number
}

export interface RefreshReport {
  scope: PollScope
  started_at: string
  sources: SourceReport[]
  failed: number
  all_failed: boolean
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json',
  md: 'text/markdown',
  html: 'text/html',
}

export function rawKeyFor(source: FetchSource, fetchedAt: string): string {
  return `raw/${source.source_id}/${fetchedAt}.${source.ext}`
}

/** One line a human can act on; zod errors as their issues, not their JSON dump. */
export function describeError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  }
  return err instanceof Error ? err.message : String(err)
}

const DETAIL_MAX = 1000

interface Fetched {
  source: FetchSource
  fetched_at: string
  body: { text: string; snapshot_id: string; unchanged: boolean } | null
  failure: string | null
}

async function fetchAndSnapshot(deps: RefreshDeps, source: FetchSource, now: () => Date) {
  const outcome = await deps.fetcher(source)
  const fetched_at = now().toISOString()
  const base = { source, fetched_at }
  if (!outcome.ok) return { ...base, body: null, failure: outcome.detail } satisfies Fetched

  const content_hash = contentHashOfText(outcome.text)
  const latest = await latestGoodSnapshot(deps.db, source.source_id)
  const unchanged = latest !== null && latest.content_hash === content_hash

  // Same bytes as the last good snapshot: record that we looked, point at the
  // object already in R2, and skip the write.
  const raw_key = unchanged ? latest.raw_key : rawKeyFor(source, fetched_at)
  if (!unchanged) {
    await deps.raw.put(raw_key, outcome.text, CONTENT_TYPES[source.ext] ?? 'text/plain')
  }

  const snapshot_id = `${source.source_id}:${fetched_at}`
  await insertRows(deps.db, 'snapshots', [
    {
      id: snapshot_id,
      source_id: source.source_id,
      content_hash,
      raw_key,
      http_status: outcome.status,
      bytes: outcome.bytes,
      source_url: source.url,
      fetched_at,
    },
  ])
  return {
    ...base,
    body: { text: outcome.text, snapshot_id, unchanged },
    failure: null,
  } satisfies Fetched
}

type Outcome = Omit<SourceReport, 'source_id'>

const quiet = (status: Outcome['status'], detail: string | null, snapshot_id: string | null) =>
  ({ status, detail, snapshot_id, added: 0, removed: 0, modified: 0, alerts: 0 }) satisfies Outcome

async function parseAndStore(
  deps: RefreshDeps,
  fetched: Fetched,
  byId: ReadonlyMap<string, Fetched>,
  whitelist: CikWhitelist,
): Promise<Outcome> {
  const { source, fetched_at, body } = fetched
  if (!body) return quiet('failed', fetched.failure, null)

  const lane = LANES[source.source_id]
  if (!lane) {
    return quiet(
      body.unchanged ? 'unchanged' : 'ok',
      'no parser: fetched for a join or as a cross-check',
      body.snapshot_id,
    )
  }

  for (const sideId of lane.sides) {
    if (!byId.get(sideId)?.body) {
      return quiet('failed', `side source ${sideId} unavailable this tick`, body.snapshot_id)
    }
  }
  // A department renamed with no job touched still changes the joined rows.
  const sideChanged = lane.sides.some((id) => !byId.get(id)!.body!.unchanged)
  if (body.unchanged && !sideChanged) return quiet('unchanged', null, body.snapshot_id)

  const parsed = lane.parse(body.text, {
    prov: { source_url: source.url, fetched_at },
    snapshotId: body.snapshot_id,
    side: (id) => byId.get(id)!.body!.text,
    whitelist,
  })
  const note = parsed.note ?? null

  const toStored = (row: EntityRow): StoredEntityRow => ({
    ...row,
    source_id: source.source_id,
    first_seen_at: row.fetched_at,
  })

  const before = await currentEntities(deps.db, source.source_id)
  if (before.length === 0) {
    // First observation: record what is there, not a wall of "added" events
    // for things that happened before we were watching.
    await insertRows(deps.db, 'entities', parsed.entities.map(toStored))
    return quiet(
      'baseline',
      [`${parsed.entities.length} entities`, note].filter(Boolean).join('; '),
      body.snapshot_id,
    )
  }
  if (parsed.entities.length === 0) {
    // An empty page that parsed cleanly is far more often an outage that
    // returned 200 than a board that really closed every role.
    return quiet(
      'failed',
      `parser returned zero rows against ${before.length} current entities; refusing to record a mass removal`,
      body.snapshot_id,
    )
  }

  const all = diff(before, parsed.entities, fetched_at)
  const changes = lane.removals === 'set' ? all : all.filter((c) => c.change_type !== 'removed')
  const afterByKey = new Map(parsed.entities.map((e) => [e.entity_key, e]))
  const added = changes.filter((c) => c.change_type === 'added')
  const modified = changes.filter((c) => c.change_type === 'modified')
  const removed = changes.filter((c) => c.change_type === 'removed')

  await insertRows(
    deps.db,
    'entities',
    added.map((c) => toStored(afterByKey.get(c.entity_key)!)),
  )
  await updateEntities(
    deps.db,
    source.source_id,
    modified.map((c) => afterByKey.get(c.entity_key)!),
  )
  await deleteEntities(
    deps.db,
    source.source_id,
    removed.map((c) => c.entity_key),
  )
  await insertRows(deps.db, 'changes', changes)
  const alerts = lane.alerts?.(changes) ?? []
  await insertRows(deps.db, 'alerts', alerts)

  return {
    status: 'ok',
    detail: note,
    snapshot_id: body.snapshot_id,
    added: added.length,
    removed: removed.length,
    modified: modified.length,
    alerts: alerts.length,
  }
}

/**
 * Poll the named sources. Never throws for a source: every failure — fetch,
 * parse, schema, store — becomes a 'failed' source_runs row and a
 * `source_failed` ops event, and the tick carries on with the next source.
 */
export async function runRefresh(
  deps: RefreshDeps,
  scope: PollScope,
  sourceIds: readonly string[],
): Promise<RefreshReport> {
  const now = deps.now ?? (() => new Date())
  const started_at = now().toISOString()
  const all = includeSources(deps.sourcesYaml, manifestFixtures)
  const whitelist = parseCikWhitelistBlock(deps.sourcesYaml)

  const unknown = sourceIds.filter((id) => !all.some((s) => s.source_id === id))
  if (unknown.length) throw new Error(`not include sources: ${unknown.join(', ')}`)

  // Sides a wanted source joins against ride along even when the caller did
  // not name them; their runs are reported like any other source's.
  const wantedIds = new Set(sourceIds)
  for (const id of sourceIds) for (const side of LANES[id]?.sides ?? []) wantedIds.add(side)
  const sources = all.filter((s) => wantedIds.has(s.source_id))

  const byId = new Map<string, Fetched>()
  for (const source of sources) {
    let fetched: Fetched
    try {
      fetched = await fetchAndSnapshot(deps, source, now)
    } catch (err) {
      fetched = { source, fetched_at: now().toISOString(), body: null, failure: describeError(err) }
    }
    byId.set(source.source_id, fetched)
  }

  const reports: SourceReport[] = []
  for (const source of sources) {
    const fetched = byId.get(source.source_id)!
    let outcome: Outcome
    try {
      outcome = await parseAndStore(deps, fetched, byId, whitelist)
    } catch (err) {
      outcome = quiet('failed', describeError(err), fetched.body?.snapshot_id ?? null)
    }
    const detail = outcome.detail?.slice(0, DETAIL_MAX) ?? null

    if (outcome.status === 'failed') {
      await recordOpsEvent(deps.db, {
        kind: 'source_failed',
        detail: `${source.source_id}: ${detail ?? 'unknown failure'}`,
        path: source.url,
      })
    }
    // Written last, after the entity writes — see latestGoodSnapshot() for why.
    await insertRows(deps.db, 'source_runs', [
      {
        id: `${scope}:${source.source_id}:${started_at}`,
        scope,
        source_id: source.source_id,
        started_at,
        status: outcome.status,
        detail,
        snapshot_id: outcome.snapshot_id,
        added: outcome.added,
        removed: outcome.removed,
        modified: outcome.modified,
        source_url: source.url,
      },
    ])
    reports.push({ source_id: source.source_id, ...outcome, detail })
  }

  const failed = reports.filter((r) => r.status === 'failed').length
  const all_failed = reports.length > 0 && failed === reports.length
  if (all_failed) {
    await recordOpsEvent(deps.db, {
      kind: 'all_sources_failed',
      detail: `${scope}: all ${failed} sources failed`,
    })
  }
  return { scope, started_at, sources: reports, failed, all_failed }
}
