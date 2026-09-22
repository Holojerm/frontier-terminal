import { ZodError } from 'zod'

import { recordOpsEvent } from '../utils/ops'
import type { ClassEntry } from '../utils/terminal-classes'
import { effectiveClassMap } from './class-map'
import {
  contentHashOfText,
  type ChangeRow,
  type EntityRow,
  type PollScope,
  type Provider,
  type SourceRunRow,
  type StoredEntityRow,
} from './contracts'
import { diff } from './diff'
import { modelFloorAlerts } from './model-floor'
import type { SourceFetcher } from './fetch'
import { derivedKeyOf, laneFor } from './lanes'
import { deriveSources, resolvedFilers } from './derived'
import { manifestFixtures } from './parsers/fixture-provenance'
import { parsePendingFilersBlock, type PendingFilers } from './parsers/sec/pending-filers'
import { parseRevenueFilersBlock, type RevenueFilers } from './parsers/sec/revenue-filers'
import { parseCikWhitelistBlock, type CikWhitelist } from './parsers/sec/whitelist'
import { JoinRaceError } from './parsers/hiring/common'
import { includeSources, type FetchSource } from './sources'
import {
  currentEntities,
  deleteEntities,
  insertRows,
  lastRunStatus,
  lastSkippedRunAt,
  latestGoodSnapshot,
  updateEntities,
  type PipelineDb,
} from './store'

// One poll tick: fetch → hash → snapshot → parse → normalize → diff → store,
// per source, with every stage's outcome written to source_runs.
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

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
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

/** How often an unconfigured source may say so in the ops digest. */
export const SKIPPED_EVENT_INTERVAL_MS = 24 * 60 * 60 * 1000

interface Fetched {
  source: FetchSource
  fetched_at: string
  body: {
    text: string
    snapshot_id: string
    unchanged: boolean
    /** No earlier good run for this source: whatever parses is the baseline. */
    first: boolean
  } | null
  failure: string | null
  /** True when the fetcher refused for want of a credential (nothing attempted). */
  skipped: boolean
  /** True when a DERIVED url 404d — the document is not published, see rows.ts. */
  absent: boolean
}

async function fetchAndSnapshot(deps: RefreshDeps, source: FetchSource, now: () => Date) {
  const outcome = await deps.fetcher(source)
  const fetched_at = now().toISOString()
  const base = { source, fetched_at }
  if (!outcome.ok) {
    return {
      ...base,
      body: null,
      failure: outcome.detail,
      skipped: 'skipped' in outcome && outcome.skipped,
      // Only for a derived id. An audited url that 404s is breakage — the
      // audit recorded that it resolved — so that one stays a failure.
      absent: outcome.status === 404 && derivedKeyOf(source.source_id) !== null,
    } satisfies Fetched
  }

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
    body: { text: outcome.text, snapshot_id, unchanged, first: latest === null },
    failure: null,
    skipped: false,
    absent: false,
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
  revenueFilers: RevenueFilers,
  pendingFilers: PendingFilers,
  resolvedProviders: ReadonlySet<Provider>,
  classMap: readonly ClassEntry[],
): Promise<Outcome> {
  const { source, fetched_at, body } = fetched
  if (!body) {
    const status = fetched.skipped ? 'skipped' : fetched.absent ? 'absent' : 'failed'
    return quiet(status, fetched.failure, null)
  }

  const lane = laneFor(source.source_id)
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
    revenueFilers,
    pendingFilers,
    resolvedProviders,
    derivedKey: derivedKeyOf(source.source_id),
    classMap,
  })
  const note = parsed.note ?? null

  const toStored = (row: EntityRow): StoredEntityRow => ({
    ...row,
    source_id: source.source_id,
    first_seen_at: row.fetched_at,
  })

  const before = await currentEntities(deps.db, source.source_id)
  if (body.first) {
    // First observation: record what is there, not a wall of "added" events
    // for things that happened before we were watching — a status feed's
    // whole backlog, a filer's recent window. Decided by "no earlier good
    // run", not by an empty current set: a filtered feed can legitimately
    // baseline at zero rows, and its first real row must then be 'added'.
    await insertRows(deps.db, 'entities', parsed.entities.map(toStored))
    return quiet(
      'baseline',
      [`${parsed.entities.length} entities`, note].filter(Boolean).join('; '),
      body.snapshot_id,
    )
  }
  if (parsed.entities.length === 0 && lane.removals === 'set') {
    // An empty page that parsed cleanly is far more often an outage that
    // returned 200 than a board that really closed every role. An
    // append-only feed is different: an empty window removes nothing.
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
  const alerts = [
    ...(lane.alerts?.(changes) ?? []),
    ...(await modelFloorAlerts(deps.db, source.source_id, changes)),
  ]
  await insertRows(deps.db, 'alerts', alerts)
  // A vendor rewrote a sentence the class map rests on: the owner has a
  // transcription to redo. Once per flip — an unchanged verdict diffs to
  // nothing, so a stale cell does not re-spool every tick.
  for (const change of recommendationsLost(modified)) {
    await recordOpsEvent(deps.db, {
      kind: 'class_basis_stale',
      detail: `${source.source_id}: ${change}`,
      path: source.url,
    })
  }

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

/** One line per 'recommendation' change whose after-state lost the sentence. */
function recommendationsLost(modified: readonly ChangeRow[]): string[] {
  const lines: string[] = []
  for (const change of modified) {
    if (change.entity_type !== 'recommendation' || !change.after_json) continue
    const after = JSON.parse(change.after_json) as {
      class?: string
      model_slug?: string
      present?: boolean
    }
    if (after.present !== false) continue
    lines.push(
      `${change.provider} ${after.class} (${after.model_slug}) — vendor sentence no longer on the page`,
    )
  }
  return lines
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
  // The audited sources plus the ones the store derives for itself (a
  // resolved lab's feeds, the OpenAI model pages) — server/pipeline/derived.ts.
  const all = [
    ...includeSources(deps.sourcesYaml, manifestFixtures),
    ...(await deriveSources(deps.db, deps.sourcesYaml)),
  ]
  // A resolved lab joins the whitelist and the revenue filers for this tick
  // under its provider id, as an issuer; the audited file's entries win a
  // collision, so a lab tagged there is never re-resolved.
  const whitelist = new Map(parseCikWhitelistBlock(deps.sourcesYaml))
  const revenueFilers = new Map(parseRevenueFilersBlock(deps.sourcesYaml))
  const pendingFilers = parsePendingFilersBlock(deps.sourcesYaml)
  const resolvedProviders = new Set<Provider>()
  for (const [provider, filer] of revenueFilers) if (filer) resolvedProviders.add(provider)
  for (const filer of await resolvedFilers(deps.db)) {
    if (resolvedProviders.has(filer.provider)) continue
    resolvedProviders.add(filer.provider)
    whitelist.set(filer.provider.toUpperCase(), filer.cik)
    revenueFilers.set(filer.provider, { ticker: filer.provider.toUpperCase(), relation: 'issuer' })
  }

  // The drift check runs against the map in effect — the seed plus any judge
  // decision — so a re-mapped cell is checked for its new sentence.
  const classMap = await effectiveClassMap(deps.db)

  const unknown = sourceIds.filter((id) => !all.some((s) => s.source_id === id))
  if (unknown.length) throw new Error(`not include sources: ${unknown.join(', ')}`)

  // Sides a wanted source joins against ride along even when the caller did
  // not name them; their runs are reported like any other source's.
  const wantedIds = new Set(sourceIds)
  for (const id of sourceIds) for (const side of laneFor(id)?.sides ?? []) wantedIds.add(side)
  const sources = all.filter((s) => wantedIds.has(s.source_id))

  const byId = new Map<string, Fetched>()
  for (const source of sources) {
    let fetched: Fetched
    try {
      fetched = await fetchAndSnapshot(deps, source, now)
    } catch (err) {
      fetched = {
        source,
        fetched_at: now().toISOString(),
        body: null,
        failure: describeError(err),
        skipped: false,
        absent: false,
      }
    }
    byId.set(source.source_id, fetched)
  }

  const reports: SourceReport[] = []
  for (const source of sources) {
    const fetched = byId.get(source.source_id)!
    let outcome: Outcome
    // A failure the next tick clears was a blip. Only one class is known to
    // self-resolve — the Greenhouse snapshot race — and it says so by type.
    let transient = false
    try {
      outcome = await parseAndStore(
        deps,
        fetched,
        byId,
        whitelist,
        revenueFilers,
        pendingFilers,
        resolvedProviders,
        classMap,
      )
    } catch (err) {
      transient = err instanceof JoinRaceError
      outcome = quiet('failed', describeError(err), fetched.body?.snapshot_id ?? null)
    }
    const detail = outcome.detail?.slice(0, DETAIL_MAX) ?? null

    if (outcome.status === 'failed') {
      // The run is recorded either way — the coverage panel shows every one.
      // The mail waits a tick for a transient class, so a race that resolves
      // itself before anyone could have acted on it never becomes an alert,
      // and one that does not resolve still does.
      const persists = !transient || (await lastRunStatus(deps.db, source.source_id)) === 'failed'
      if (persists) {
        await recordOpsEvent(deps.db, {
          kind: 'source_failed',
          detail: `${source.source_id}: ${detail ?? 'unknown failure'}`,
          path: source.url,
        })
      }
    } else if (outcome.status === 'absent') {
      // On the transition only. A SKU that has never had a model page has
      // nothing to report; a page that was there last tick and is gone now is
      // the event, and for this product it is the interesting kind.
      if ((await lastRunStatus(deps.db, source.source_id)) !== 'absent') {
        await recordOpsEvent(deps.db, {
          kind: 'source_absent',
          detail: `${source.source_id}: ${detail ?? 'no document at this url'}`,
          path: source.url,
        })
      }
    } else if (outcome.status === 'skipped') {
      // Once a day, not once a tick: the previous skipped run is the marker.
      const last = await lastSkippedRunAt(deps.db, source.source_id)
      const recent =
        last !== null && Date.parse(started_at) - Date.parse(last) < SKIPPED_EVENT_INTERVAL_MS
      if (!recent) {
        await recordOpsEvent(deps.db, {
          kind: 'source_unconfigured',
          detail: `${source.source_id}: ${detail ?? 'skipped'}`,
          path: source.url,
        })
      }
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
  // A skipped source was never attempted, so it is neither a failure nor a
  // success — it does not count toward "everything failed".
  const attempted = reports.filter((r) => r.status !== 'skipped').length
  const all_failed = attempted > 0 && failed === attempted
  if (all_failed) {
    await recordOpsEvent(deps.db, {
      kind: 'all_sources_failed',
      detail: `${scope}: all ${failed} sources failed`,
    })
  }
  return { scope, started_at, sources: reports, failed, all_failed }
}
