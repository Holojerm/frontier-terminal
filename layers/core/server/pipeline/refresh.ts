import { ZodError } from 'zod'

import { recordOpsEvent } from '#server/utils/ops'
import {
  contentHash,
  contentHashOfText,
  SnapshotRow,
  type AlertRow,
  type ChangeRow,
  type EntityRow,
  type PollScope,
  type SourceRunRow,
  type StoredEntityRow,
} from '#layers/core/server/utils/contracts'
import { diff, repeatChangeId } from '#layers/core/server/pipeline/diff'
import type { SourceFetcher } from '#layers/core/server/utils/pipeline-fetch'
import type { RawStore } from '#layers/core/server/utils/pipeline-raw'
import { CHANGE_ALERTS, derivedKeyOf, laneFor, PAYLOAD_REDACTIONS } from '#server/registries/lanes'
import { deriveSources } from '#server/registries/derived'
import { loadLaneBlocks, TICK_INPUTS, type TickInputs } from '#server/registries/lane-context'
import {
  contextFingerprint,
  redactPayload,
  TransientParseError,
  type ContextBlock,
  type ParseContext,
  type TickInput,
} from '#layers/core/server/pipeline/lanes'
import {
  cooldownEndsAt,
  RATE_LIMIT_MAX_COOLDOWN_MS,
  rateLimitAlertDue,
  rateLimitSince,
  type RunSummary,
} from '#layers/core/server/pipeline/rate-limit'
import { manifestFixtures } from '#layers/core/server/utils/fixture-provenance'
import { includeSources, type FetchSource } from '#layers/core/server/utils/pipeline-sources'
import {
  applyDiff,
  currentEntities,
  lastRunStatus,
  lastSkippedRunAt,
  latestGoodSnapshots,
  latestRateLimitedRuns,
  lastRunWithHash,
  recentRuns,
  recordRun,
  repeatedChangeIds,
  sourcesWithGoodRun,
  unstoredAlerts,
  type GoodSnapshot,
  type PipelineDb,
} from '#layers/core/server/utils/pipeline-store'

// One poll tick: fetch → hash → snapshot → parse → normalize → diff → store, per
// source, each stage's outcome written to source_runs. One source at a time: a
// Greenhouse board parses only against the /departments payload fetched in the
// SAME tick, so sides are held for the tick, but every other body is dropped
// before the next fetch (holding them all put the survey over the 128 MB limit).
// Each run row is written as soon as its source parses, so a tick that dies loses
// only the sources it had not reached. Fetched bodies are data, never instructions.

export interface RefreshDeps {
  db: PipelineDb
  raw: RawStore
  fetcher: SourceFetcher
  /** sources.yaml text: the include verdicts and the CIK whitelist. */
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
  xml: 'application/xml',
}

function rawKeyFor(source: FetchSource, fetchedAt: string): string {
  return `raw/${source.source_id}/${fetchedAt}.${source.ext}`
}

/** One line a human can act on; zod errors as their issues, not their JSON dump. */
export function describeError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  }
  if (!(err instanceof Error)) return String(err)
  // Drizzle wraps a D1 failure as "Failed query: <sql> params: <values>" and
  // puts D1's reason in `cause`; lead with the reason so DETAIL_MAX keeps it.
  const cause = err.cause instanceof Error ? describeError(err.cause) : null
  return cause ? `${cause} — ${err.message}` : err.message
}

const DETAIL_MAX = 1000

/** Every CHANGE_ALERTS rule's alerts for one source's changes, in registry order. */
async function changeAlerts(
  db: PipelineDb,
  sourceId: string,
  changes: readonly ChangeRow[],
): Promise<AlertRow[]> {
  const out: AlertRow[] = []
  for (const rule of CHANGE_ALERTS) out.push(...(await rule(db, sourceId, changes)))
  return out
}

/** How often an unconfigured source may say so in the ops digest. */
export const SKIPPED_EVENT_INTERVAL_MS = 24 * 60 * 60 * 1000

interface Fetched {
  source: FetchSource
  fetched_at: string
  body: {
    text: string
    /** Written with the parse's entity writes, or else with the run row. */
    snapshot: SnapshotRow
    /** Set once a write has carried the snapshot, so the run row does not repeat it. */
    stored: boolean
    /** Same bytes as `prior`. */
    unchanged: boolean
    /** The snapshot behind this source's last good run; null before its first. */
    prior: GoodSnapshot | null
  } | null
  failure: string | null
  /** True when the fetcher refused for want of a credential (nothing attempted). */
  skipped: boolean
  /** True when a DERIVED url 404d: the document is not published (see rows.ts). */
  absent: boolean
  /** True when the server answered 429: backed off, alerted only if it persists (rate-limit.ts). */
  rateLimited: boolean
  /** True when the server answered 403: alerted only if the next tick is refused too. */
  refused: boolean
  /** True when the source is inside the cooldown a 429 started: not fetched, not recorded. */
  cooling: boolean
}

async function fetchAndSnapshot(
  deps: RefreshDeps,
  source: FetchSource,
  now: () => Date,
  prior: GoodSnapshot | null,
) {
  const outcome = await deps.fetcher(source)
  const fetched_at = now().toISOString()
  const base = { source, fetched_at }
  if (!outcome.ok) {
    return {
      ...base,
      body: null,
      failure: outcome.detail,
      skipped: 'skipped' in outcome && outcome.skipped,
      // Only for a derived id. An audited url that 404s is breakage (the
      // audit recorded that it resolved), so that one stays a failure.
      absent: outcome.status === 404 && derivedKeyOf(source.source_id) !== null,
      rateLimited: outcome.status === 429,
      refused: outcome.status === 403,
      cooling: false,
    } satisfies Fetched
  }

  const text = redactPayload(PAYLOAD_REDACTIONS, source.url, outcome.text)
  const content_hash = contentHashOfText(text)
  const unchanged = prior !== null && prior.content_hash === content_hash

  // Same bytes as the last good snapshot: record that we looked, point at the
  // object already in R2, and skip the write.
  const raw_key = unchanged ? prior.raw_key : rawKeyFor(source, fetched_at)
  if (!unchanged) {
    await deps.raw.put(raw_key, text, CONTENT_TYPES[source.ext] ?? 'text/plain')
  }

  return {
    ...base,
    body: {
      text,
      // Validated now, so a bad row fails this fetch rather than the run
      // row's write later.
      snapshot: SnapshotRow.parse({
        id: `${source.source_id}:${fetched_at}`,
        source_id: source.source_id,
        content_hash,
        raw_key,
        http_status: outcome.status,
        bytes: outcome.bytes,
        source_url: source.url,
        fetched_at,
      }),
      stored: false,
      unchanged,
      prior,
    },
    failure: null,
    skipped: false,
    absent: false,
    rateLimited: false,
    refused: false,
    cooling: false,
  } satisfies Fetched
}

/** A run's outcome, plus the parse basis its run row records. */
type Outcome = Omit<SourceReport, 'source_id'> & { basis?: string | null }

const quiet = (
  status: Outcome['status'],
  detail: string | null,
  snapshot_id: string | null,
  basis: string | null = null,
) =>
  ({
    status,
    detail,
    snapshot_id,
    added: 0,
    removed: 0,
    modified: 0,
    alerts: 0,
    basis,
  }) satisfies Outcome

/**
 * Whether a parse may be skipped, stored on its run row as two hashes. `input`
 * is what the parse read: the page, its sides, and each tick input's cited
 * part. `context` is what it read them with: the parser version, the lane's
 * sources.yaml blocks and the URL its rows cite (lanes.ts › contextFingerprint).
 * A new input is logged as news; a new context alone is re-read quietly.
 */
interface ParseBasis {
  input: string
  context: string
}

/** Every tick input, loaded once for the tick (server/registries/lane-context.ts). */
async function loadTickInputs(db: PipelineDb): Promise<TickInputs> {
  const entries = await Promise.all(
    Object.entries(TICK_INPUTS).map(
      async ([name, input]) => [name, await (input as TickInput<unknown>).load(db)] as const,
    ),
  )
  return Object.fromEntries(entries) as TickInputs
}

/** The part of each tick input the parse of `sourceIds` reads, under its basis key. */
function citedInputs(inputs: TickInputs, sourceIds: readonly string[]): Record<string, unknown> {
  const cited: Record<string, unknown> = {}
  for (const [name, input] of Object.entries(TICK_INPUTS) as [
    keyof TickInputs,
    TickInput<unknown>,
  ][]) {
    cited[input.basisKey] = input.cited(inputs[name], sourceIds)
  }
  return cited
}

/**
 * A 'set' lane refuses a parse that would remove more than this share of its
 * current entities. A board that loses half its roles between two polls six
 * hours apart is far more often a page that half-rendered, a filter that
 * changed, or a parser that lost a section than a lab that halved its hiring;
 * the zero-row guard alone let a page that kept one row through.
 */
const MASS_REMOVAL_SHARE = 0.5
/** Below this many current entities the share is noise: a two-model catalog
 * that drops one is half its set and is an ordinary removal. */
const MASS_REMOVAL_MIN_SET = 20
/** How a refused mass removal's run detail starts, so the next run can find it. */
const MASS_REMOVAL_DETAIL = 'parse would remove'

type ContextBlocks = Pick<ParseContext, ContextBlock>

/** The stored context of a read that left parts unread (ParseResult.problems). */
const INCOMPLETE = 'incomplete'

async function parseAndStore(
  deps: RefreshDeps,
  fetched: Fetched,
  byId: ReadonlyMap<string, Fetched>,
  blocks: ContextBlocks,
  inputs: TickInputs,
): Promise<Outcome> {
  const { source, fetched_at, body } = fetched
  if (!body) {
    const status = fetched.skipped ? 'skipped' : fetched.absent ? 'absent' : 'failed'
    return quiet(status, fetched.failure, null)
  }
  const { snapshot, prior } = body

  const lane = laneFor(source.source_id)
  if (!lane) {
    return quiet(
      body.unchanged ? 'unchanged' : 'ok',
      'no parser: fetched for a join or as a cross-check',
      snapshot.id,
    )
  }

  for (const sideId of lane.sides) {
    if (!byId.get(sideId)?.body) {
      return quiet('failed', `side source ${sideId} unavailable this tick`, snapshot.id)
    }
  }
  // Sides are compared with the bytes this source's last good parse joined
  // against, not with the side's own last run: a department renamed on a tick
  // this board failed to parse is still unread here.
  const sides = Object.fromEntries(
    lane.sides.map((id) => [id, byId.get(id)!.body!.snapshot.content_hash]),
  )
  const basis: ParseBasis = {
    input: contentHash({
      page: snapshot.content_hash,
      sides,
      ...citedInputs(inputs, [source.source_id, ...lane.sides]),
    }),
    context: contextFingerprint(lane, blocks, source.url),
  }
  const basisJson = JSON.stringify(basis)
  const stored = prior?.parse_basis ? (JSON.parse(prior.parse_basis) as Partial<ParseBasis>) : null
  // A run with no basis of this shape (the first tick after a deploy that
  // changed it) has only its page bytes to go on: the same bytes are re-read
  // once, quietly, and new bytes are logged as ever.
  const sameInput = stored?.input ? stored.input === basis.input : body.unchanged
  if (sameInput && stored?.context === basis.context) {
    return quiet('unchanged', null, snapshot.id, basisJson)
  }
  // Only the parser, the sources.yaml blocks it reads or the URL changed.
  // Whatever the parse now says differently, the page did not say it
  // differently: rows are rewritten in place and nothing is logged. Not after
  // an incomplete read: what the page said all along, read for the first
  // time, is still news (a filing's revenue once its parser is fixed).
  const reread = sameInput && stored?.context !== INCOMPLETE
  const movedFrom = prior && prior.source_url !== source.url ? prior.source_url : null

  const parsed = lane.parse(body.text, {
    prov: { source_url: source.url, fetched_at },
    snapshotId: snapshot.id,
    side: (id) => byId.get(id)!.body!.text,
    ...blocks,
    derivedKey: derivedKeyOf(source.source_id),
    ...inputs,
  })
  const note = parsed.note ?? null
  const problems = parsed.problems ?? []
  for (const problem of problems) {
    await recordOpsEvent(deps.db, {
      kind: 'source_part_failed',
      detail: `${source.source_id}: ${problem}`,
      path: source.url,
    })
  }
  // An incomplete read is never 'unchanged': the next tick reads the page again.
  const readBasis = problems.length
    ? JSON.stringify({ ...basis, context: INCOMPLETE, problems })
    : basisJson

  const toStored = (row: EntityRow): StoredEntityRow => ({
    ...row,
    source_id: source.source_id,
    first_seen_at: row.fetched_at,
  })

  const before = await currentEntities(
    deps.db,
    source.source_id,
    lane.removals === 'append-only' ? parsed.entities.map((e) => e.entity_key) : undefined,
  )
  const { changes: all, upserts } = diff(before, parsed.entities, fetched_at, source.url)
  const kept = lane.removals === 'set' ? all : all.filter((c) => c.change_type !== 'removed')
  const added = kept.filter((c) => c.change_type === 'added')
  const modified = kept.filter((c) => c.change_type === 'modified')
  const removed = kept.filter((c) => c.change_type === 'removed')
  const store = async (changes: readonly ChangeRow[], alerts: readonly unknown[]) => {
    await applyDiff(deps.db, source.source_id, {
      snapshot,
      upserts: upserts.map(toStored),
      removed: removed.map((c) => c.entity_key),
      changes,
      alerts,
    })
    body.stored = true
  }

  if (!prior && !lane.firstIsNews?.(derivedKeyOf(source.source_id), fetched_at)) {
    // First observation: record what is there, not a wall of "added" events
    // for things that happened before we were watching (a status feed's whole
    // backlog, a filer's recent window). Decided by "no earlier good run", not
    // by an empty current set: a filtered feed can baseline at zero rows, and
    // its first real row must then be 'added'. The current set is non-empty
    // here only when an earlier baseline wrote its rows and died before its run row.
    await store([], [])
    return quiet(
      'baseline',
      [`${parsed.entities.length} entities`, note].filter(Boolean).join('; '),
      snapshot.id,
      readBasis,
    )
  }
  let massRemoval: string | null = null
  if (lane.removals === 'set' && before.length > 0) {
    // An empty page that parsed cleanly is far more often an outage that
    // returned 200 than a board that really closed every role. An
    // append-only feed is different: an empty window removes nothing.
    if (parsed.entities.length === 0) {
      return quiet(
        'failed',
        `parser returned zero rows against ${before.length} current entities; refusing to record a mass removal`,
        snapshot.id,
      )
    }
    if (
      before.length >= MASS_REMOVAL_MIN_SET &&
      removed.length > before.length * MASS_REMOVAL_SHARE
    ) {
      // A half-rendered page rarely comes back byte-identical; a board that
      // really shrank does. So the same page refused on the run before this
      // one is taken as the board's new size, and a layoff costs one tick.
      const last = await lastRunWithHash(deps.db, source.source_id)
      const confirmed =
        last?.status === 'failed' &&
        last.detail?.startsWith(MASS_REMOVAL_DETAIL) === true &&
        last.content_hash === snapshot.content_hash
      if (!confirmed) {
        return quiet(
          'failed',
          `${MASS_REMOVAL_DETAIL} ${removed.length} of ${before.length} current entities; refusing to record a mass removal until the next fetch shows the same page`,
          snapshot.id,
        )
      }
      massRemoval = `removal of ${removed.length} of ${before.length} accepted: the same page was refused on the run before`
    }
  }

  // A source that moved to a new URL reads the same entities from another
  // document, so what differs is the representation: anthropic-status leaving
  // the Statuspage JSON API (robots.txt disallows /api/) for its Atom feed
  // loses impact and components on every incident still in the window. Those
  // rows are rewritten in place without a change row, as a baseline would; an
  // added or removed key still logs. A re-read of the same bytes logs nothing.
  const logged = reread ? [] : movedFrom ? kept.filter((c) => c.change_type !== 'modified') : kept
  // A transition this entity made before and has since left is a new event,
  // and needs an id of its own (diff.ts › repeatChangeId).
  const repeats = await repeatedChangeIds(deps.db, logged)
  const changes = logged.map((c) => (repeats.has(c.id) ? repeatChangeId(c) : c))

  // Alerts are computed before anything is written, so the whole diff lands
  // in one transaction (see applyDiff).
  const alerts = await unstoredAlerts(deps.db, [
    ...(lane.alerts?.(changes) ?? []),
    ...(await changeAlerts(deps.db, source.source_id, changes)),
  ])
  await store(changes, alerts)
  // What the lane says the owner has to redo by hand (the class map's
  // sentences: pricing's recommendations.ts › basisStaleEvents).
  for (const event of lane.opsEvents?.(modified) ?? []) {
    await recordOpsEvent(deps.db, {
      kind: event.kind,
      detail: `${source.source_id}: ${event.detail}`,
      path: source.url,
    })
  }

  const rows = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`
  // Rows rewritten under a key that was already there.
  const rewritten = upserts.length - added.length
  const reshaped = upserts.length + removed.length
  const unlogged = movedFrom
    ? `moved from ${movedFrom}: ${rows(reread ? reshaped : rewritten)} re-read in place, not logged as changes`
    : reread && reshaped
      ? `parser or sources.yaml changed: ${rows(reshaped)} re-read in place, not logged as changes`
      : null
  return {
    status: 'ok',
    detail: [massRemoval, unlogged, note].filter(Boolean).join('; ') || null,
    snapshot_id: snapshot.id,
    added: reread ? 0 : added.length,
    removed: reread ? 0 : removed.length,
    modified: reread || movedFrom ? 0 : modified.length,
    alerts: alerts.length,
    basis: readBasis,
  }
}

/**
 * Poll the named sources. Never throws for a source: every failure (fetch,
 * parse, schema, store) becomes a 'failed' source_runs row and a
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
  // resolved lab's feeds, the OpenAI model pages): server/registries/derived.ts › deriveSources.
  const all = [
    ...includeSources(deps.sourcesYaml, manifestFixtures),
    ...(await deriveSources(deps.db, deps.sourcesYaml)),
  ]
  // The sources.yaml blocks every lane may read, built once for the tick.
  const blocks = await loadLaneBlocks(deps.db, deps.sourcesYaml)

  // What every parse this tick reads from a domain: the class map in effect,
  // so a re-mapped cell is checked for its new sentence.
  const inputs = await loadTickInputs(deps.db)

  const unknown = sourceIds.filter((id) => !all.some((s) => s.source_id === id))
  if (unknown.length) throw new Error(`not include sources: ${unknown.join(', ')}`)

  // Sides a wanted source joins against ride along even when the caller did
  // not name them; their runs are reported like any other source's.
  const wantedIds = new Set(sourceIds)
  for (const id of sourceIds) for (const side of laneFor(id)?.sides ?? []) wantedIds.add(side)
  const sources = all.filter((s) => wantedIds.has(s.source_id))

  // Sources a recent 429 put on cooldown, and each source's last good
  // snapshot. One query each for the tick: the poll lock keeps another tick
  // from writing a newer one meanwhile.
  const rateLimited = await latestRateLimitedRuns(
    deps.db,
    new Date(Date.parse(started_at) - RATE_LIMIT_MAX_COOLDOWN_MS).toISOString(),
  )
  const priors = await latestGoodSnapshots(
    deps.db,
    sources.map((s) => s.source_id),
  )

  const fetchOne = async (source: FetchSource): Promise<Fetched> => {
    try {
      const cooldownEnd = cooldownEndsAt(rateLimited.get(source.source_id))
      if (cooldownEnd !== null && Date.parse(started_at) < cooldownEnd) {
        return {
          source,
          fetched_at: now().toISOString(),
          body: null,
          failure: null,
          skipped: false,
          absent: false,
          rateLimited: false,
          refused: false,
          cooling: true,
        }
      }
      return await fetchAndSnapshot(deps, source, now, priors.get(source.source_id) ?? null)
    } catch (err) {
      return {
        source,
        fetched_at: now().toISOString(),
        body: null,
        failure: describeError(err),
        skipped: false,
        absent: false,
        rateLimited: false,
        refused: false,
        cooling: false,
      }
    }
  }

  // Only side payloads live for the whole tick; parseAndStore reads nothing
  // else from this map. A side is fetched just before the first source that
  // joins against it, so the pair stays as close in time as the Greenhouse
  // join race needs (TransientParseError), and is reused when its own turn comes.
  const sideIds = new Set(sources.flatMap((s) => laneFor(s.source_id)?.sides ?? []))
  const bySource = new Map(sources.map((s) => [s.source_id, s]))
  const byId = new Map<string, Fetched>()
  const fetchHeld = async (source: FetchSource): Promise<Fetched> => {
    const held = byId.get(source.source_id)
    if (held) return held
    const fetched = await fetchOne(source)
    if (sideIds.has(source.source_id)) byId.set(source.source_id, fetched)
    return fetched
  }

  const reports: SourceReport[] = []
  for (const source of sources) {
    for (const sideId of laneFor(source.source_id)?.sides ?? []) {
      await fetchHeld(bySource.get(sideId)!)
    }
    const fetched = await fetchHeld(source)
    if (fetched.cooling) continue
    let outcome: Outcome
    // A failure the next tick clears was a blip. Two classes self-resolve: a
    // parser's own race (TransientParseError, the Greenhouse snapshot race)
    // and a 403 from a vendor edge that turns away the odd request (OpenAI's
    // docs host refused four polls in a day while every other one succeeded).
    let transient = fetched.refused
    try {
      outcome = await parseAndStore(deps, fetched, byId, blocks, inputs)
    } catch (err) {
      transient ||= err instanceof TransientParseError
      outcome = quiet('failed', describeError(err), fetched.body?.snapshot.id ?? null)
    }
    const detail = outcome.detail?.slice(0, DETAIL_MAX) ?? null

    if (outcome.status === 'failed') {
      // The run is recorded either way (the coverage panel shows every one).
      // The mail waits a tick for a transient class, so a race that resolves
      // itself before anyone could act never becomes an alert, and one that
      // does not still does. A 429 is the vendor's limiter, not breakage: it
      // waits for the streak to outlast a transient squeeze (rate-limit.ts).
      let persists: boolean
      let alertDetail = detail
      if (fetched.rateLimited) {
        const history: RunSummary[] = await recentRuns(deps.db, source.source_id, 100)
        persists = rateLimitAlertDue(history, Date.parse(started_at))
        const since = rateLimitSince(history)
        if (since) alertDetail = `${detail}; 429 on every attempt since ${since}`
      } else {
        persists = !transient || (await lastRunStatus(deps.db, source.source_id)) === 'failed'
      }
      if (persists) {
        await recordOpsEvent(deps.db, {
          kind: 'source_failed',
          detail: `${source.source_id}: ${alertDetail ?? 'unknown failure'}`,
          path: source.url,
        })
      }
    } else if (outcome.status === 'absent') {
      // On the transition only, and only for a page that once parsed. A SKU
      // that has never had a model page has nothing to report (the coverage
      // panel shows it); a page that was there and is gone is the event. A
      // first run has no previous status, so "not absent last time" alone
      // mailed every new SKU.
      const wasAbsent = (await lastRunStatus(deps.db, source.source_id)) === 'absent'
      const everParsed = (await sourcesWithGoodRun(deps.db, [source.source_id])).has(
        source.source_id,
      )
      if (!wasAbsent && everParsed) {
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
    // Written last, after the entity writes (see latestGoodSnapshots() for why).
    await recordRun(
      deps.db,
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
        parse_basis: outcome.basis ?? null,
      },
      fetched.body && !fetched.body.stored ? fetched.body.snapshot : null,
    )
    const { basis: _basis, ...reported } = outcome
    reports.push({ source_id: source.source_id, ...reported, detail })
  }

  const failed = reports.filter((r) => r.status === 'failed').length
  // A skipped source was never attempted, so it is neither a failure nor a
  // success and does not count toward "everything failed".
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
