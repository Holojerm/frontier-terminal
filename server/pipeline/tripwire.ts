import { eq } from 'drizzle-orm'

import * as tables from '../db/schema'
import { laneFor } from './lanes'
import { withPollLock } from './lock'
import { manifestFixtures } from './parsers/fixture-provenance'
import type { PollDeps } from './poll'
import { runRefresh, type RefreshReport } from './refresh'
import { includeSources, type FetchSource } from './sources'

// The launch tripwire, every five minutes: fetch each lab's model catalog,
// parse it in memory, and compare the parsed rows with the stored ones. Only
// when they differ (a new model, a price, the vendor's recommendation
// sentence) does it run a real poll of the catalogs and price lists.
//
// It compares parsed rows and not body hashes because the Google pricing page
// is re-rendered with different bytes on every request, so a hash check
// would trip every tick. Parsed rows change only when the catalog does.
//
// A quiet tick writes nothing: no snapshot, no source_runs row, no R2
// object. The terminal's cache key is the newest source_runs stamp
// (server/utils/terminal-cache.ts), so a quiet tripwire leaves every cached
// page valid, and a tripped one invalidates them as any poll does.
//
// News and RSS feeds were considered as the trigger and rejected: Anthropic
// and xAI publish none, OpenAI's is 740 KB, and the catalog is the page the
// terminal quotes anyway.

/** The pages a launch lands on first: one catalog per lab (Google's is its price list). */
export const TRIPWIRE_SOURCES: readonly string[] = [
  'anthropic-models-md',
  'openai-models-md',
  'xai-models-md',
  'google-pricing-html',
]

/** What a tripped tick polls: the catalogs plus the price lists launches also land on. */
export const TRIPWIRE_REFRESH: readonly string[] = [
  ...TRIPWIRE_SOURCES,
  'anthropic-pricing-md',
  'openai-pricing-md',
]

const TICK_MS = 5 * 60 * 1000
const HALF_HOUR_MS = 30 * 60 * 1000

/**
 * A source that tripped is not checked again for this long. If the poll it
 * triggered could not store the change (the page fails refresh's own
 * checks), the tripwire would otherwise re-run that poll every five minutes
 * and spool the same failure each time. The same holds after a deploy that
 * changes a parser: refresh does not re-parse an unchanged body, so the
 * stored rows lag the new parser until the page next changes, and the
 * tripwire sees a difference every tick. By the time this expires, the
 * half-hourly poll has had a turn at it.
 */
export const TRIPWIRE_COOLDOWN_SECONDS = 25 * 60
export const cooldownKey = (sourceId: string) => `tripwire:cooldown:${sourceId}`

/**
 * True on the half-hour ticks, when poll:edgar (and every sixth hour
 * poll:survey) runs. The tripwire yields rather than race them for the poll
 * lock: edgar does not retry, so losing the lock would cost it a whole tick.
 */
export function isPollInstant(now: Date): boolean {
  const nearestTick = Math.round(now.getTime() / TICK_MS) * TICK_MS
  return nearestTick % HALF_HOUR_MS === 0
}

export type TripwireOutcome =
  | { status: 'yielded' }
  | { status: 'quiet'; checked: string[] }
  | { status: 'tripped'; by: string[]; skipped: string }
  | { status: 'tripped'; by: string[]; result: RefreshReport }

async function storedHashes(deps: PollDeps, sourceId: string): Promise<Map<string, string>> {
  const rows = await deps.db
    .select({ key: tables.entities.entity_key, hash: tables.entities.content_hash })
    .from(tables.entities)
    .where(eq(tables.entities.source_id, sourceId))
  return new Map(rows.map((r) => [r.key, r.hash]))
}

/** True when the page parses to rows other than the ones stored for it. */
async function differs(deps: PollDeps, source: FetchSource, fetchedAt: string): Promise<boolean> {
  const lane = laneFor(source.source_id)
  if (!lane) return false
  const outcome = await deps.fetcher(source)
  // A failing catalog is the regular poll's to report. The tripwire only
  // speaks up about change.
  if (!outcome.ok) return false
  const parsed = lane.parse(outcome.text, {
    prov: { source_url: source.url, fetched_at: fetchedAt },
    snapshotId: `tripwire:${source.source_id}`,
    side: (id) => {
      throw new Error(`tripwire lanes take no side sources (asked for ${id})`)
    },
    whitelist: new Map(),
    revenueFilers: new Map(),
    pendingFilers: { filers: [], exclude: [] },
    resolvedProviders: new Set(),
    derivedKey: null,
  })
  // A page that parses to nothing is an outage page, not a change (refresh
  // refuses to record a mass removal from one either).
  if (parsed.entities.length === 0) return false
  const stored = await storedHashes(deps, source.source_id)
  if (stored.size !== parsed.entities.length) return true
  return parsed.entities.some((e) => stored.get(e.entity_key) !== e.content_hash)
}

export async function runTripwire(deps: PollDeps): Promise<TripwireOutcome> {
  const { lock, ...refreshDeps } = deps
  const now = (deps.now ?? (() => new Date()))()
  if (isPollInstant(now)) return { status: 'yielded' }

  const sources = includeSources(deps.sourcesYaml, manifestFixtures)
  const by: string[] = []
  for (const id of TRIPWIRE_SOURCES) {
    const source = sources.find((s) => s.source_id === id)
    if (!source) throw new Error(`tripwire names a source not in sources.yaml: ${id}`)
    if ((await lock.get(cooldownKey(id))) !== null) continue
    try {
      if (await differs(deps, source, now.toISOString())) by.push(id)
    } catch (err) {
      // A parse error here is the regular poll's to record, with the snapshot.
      console.warn(
        JSON.stringify({ kind: 'tripwire_parse_failed', source: id, error: String(err) }),
      )
    }
  }
  if (by.length === 0) return { status: 'quiet', checked: [...TRIPWIRE_SOURCES] }

  const outcome = await withPollLock(
    lock,
    `tripwire@${now.toISOString()}`,
    async () => {
      for (const id of by) {
        await lock.put(cooldownKey(id), now.toISOString(), TRIPWIRE_COOLDOWN_SECONDS)
      }
      return runRefresh(refreshDeps, 'tripwire', TRIPWIRE_REFRESH)
    },
    { retries: 0, delayMs: 0 },
  )
  // Held means a poll is already running, and it covers these sources or will
  // within the half hour. The next tick checks again either way.
  if (outcome.skipped) return { status: 'tripped', by, skipped: outcome.heldBy }
  return { status: 'tripped', by, result: outcome.result }
}
