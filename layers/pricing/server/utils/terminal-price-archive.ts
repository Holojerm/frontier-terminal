// Reads of the archived price lists and rate limits (archive_captures, archived_prices,
// archived_rate_limits): the Internet Archive's captures of each lab's own pricing and
// rate-limit pages, backfilled by scripts/wayback-backfill.ts. Kept out of the live
// derivations: a live point says what this store saw when it looked, an archived one what the
// Archive saw. Every archived row a payload carries says so (basis 'archived', a wayback:
// source id, the capture URL as source_url).

import { and, asc, count, desc, eq, inArray, lte, max, min } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PriceReach, PriceRowView } from '../../shared/types/prices'
import {
  ARCHIVE_ERAS,
  ARCHIVE_GAPS,
  ARCHIVE_NOT_COVERED,
  ARCHIVE_UNTIL,
} from '../pipeline/archive/eras'
import { LIMITS_ARCHIVE_ERAS } from '../pipeline/archive/limits-eras'
import { limitChanges, type LimitChange } from '../pipeline/archive/limit-events'
import { derivePriceEvents, type ArchivedPriceEvent } from '../pipeline/archive/price-events'
import releaseNotes from '../pipeline/archive/release-notes.json'
import type { ReleaseNotesFile } from '../pipeline/archive/release-notes-file'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import { parsedOn, archiveSourceId } from '#layers/core/server/utils/archive-floor'
import type { ArchivedPrice } from './terminal-price-history'
import { byString, num, parseJson, str } from '#layers/core/server/utils/terminal-json'
import { PROVIDER_ORDER, type SourceRegistry } from '#layers/core/server/utils/terminal-sources'

/** The first day the live loaders count: the archived price lists end here. */
const LIVE_FROM = ARCHIVE_UNTIL.slice(0, 10)

export const ARCHIVE_SOURCE_NOTE =
  'Read from the Internet Archive’s capture of the lab’s own pricing page, before this site watched it.'

export const ARCHIVED_LABS_AS_OF_METHOD =
  'Each lab’s live record starts at our first fetch of its own pricing pages, and some labs were added later than others. A lab we hadn’t fetched by as_of is answered from the Internet Archive: the price list on the newest capture of its pricing page at or before as_of that we could read. That is event time (when the Archive saw the page), not knowledge time: we read these captures back long after. Its rows’ source_url is the capture, fetched_at when we read it. The like-for-like matrix is built from live rows only.'

export const ARCHIVED_AS_OF_METHOD =
  'as_of is before this site’s first fetch, so this answer is rebuilt from the Internet Archive: per lab, the price list on the newest capture of its pricing page at or before as_of that we could read. That is event time (when the Archive saw the page), not knowledge time: we read these captures back long after, so this store did not hold them at as_of. Each row’s source_url is the capture, fetched_at when we read it. Labs with no readable capture by as_of have no rows. The like-for-like matrix is not rebuilt from the archive.'

/** archived_prices rows of one key, captured at or before `until`. */
export async function archivedRowsForKey(
  db: PipelineDb,
  key: string,
  until: string | null,
): Promise<ArchivedPrice[]> {
  const where = until
    ? and(eq(tables.archivedPrices.entity_key, key), lte(tables.archivedPrices.captured_at, until))
    : eq(tables.archivedPrices.entity_key, key)
  return db
    .select({
      capture_id: tables.archivedPrices.capture_id,
      entity_key: tables.archivedPrices.entity_key,
      content_hash: tables.archivedPrices.content_hash,
      payload: tables.archivedPrices.payload,
      captured_at: tables.archivedPrices.captured_at,
      source_url: tables.archivedPrices.source_url,
      fetched_at: tables.archivedPrices.fetched_at,
    })
    .from(tables.archivedPrices)
    .where(where)
    .orderBy(asc(tables.archivedPrices.captured_at))
}

export interface ArchivedCatalog {
  rows: PriceRowView[]
  /** The capture each lab's rows come from: what point_in_time cites. */
  captures: { provider: string; capture_id: string; captured_at: string; source_url: string }[]
}

/**
 * Every lab's price list as of `at`, from the archive: per lab, the rows of
 * its newest parsed capture at or before `at`. A lab whose newest readable
 * capture sits before a gap is still answered from it, and the payload's
 * point_in_time names that capture so the reader sees how old it is.
 */
export async function archivedCatalogAt(
  db: PipelineDb,
  at: string,
  /** Only these labs; every lab when absent. */
  labs?: readonly string[],
): Promise<ArchivedCatalog> {
  const newest = await db
    .select({
      provider: tables.archiveCaptures.provider,
      captured_at: max(tables.archiveCaptures.captured_at),
    })
    .from(tables.archiveCaptures)
    .where(and(parsedOn('pricing'), lte(tables.archiveCaptures.captured_at, at)))
    .groupBy(tables.archiveCaptures.provider)
  const captures: ArchivedCatalog['captures'] = []
  for (const n of newest) {
    if (!n.captured_at || (labs && !labs.includes(n.provider))) continue
    const [c] = await db
      .select({
        id: tables.archiveCaptures.id,
        source_url: tables.archiveCaptures.source_url,
      })
      .from(tables.archiveCaptures)
      .where(
        and(
          eq(tables.archiveCaptures.provider, n.provider),
          parsedOn('pricing'),
          eq(tables.archiveCaptures.captured_at, n.captured_at),
        ),
      )
      .orderBy(desc(tables.archiveCaptures.id))
      .limit(1)
    if (c) {
      captures.push({
        provider: n.provider,
        capture_id: c.id,
        captured_at: n.captured_at,
        source_url: c.source_url,
      })
    }
  }
  captures.sort((a, b) => byString(a.provider, b.provider))
  if (captures.length === 0) return { rows: [], captures }

  const stored = await db
    .select()
    .from(tables.archivedPrices)
    .where(
      inArray(
        tables.archivedPrices.capture_id,
        captures.map((c) => c.capture_id),
      ),
    )
  const rows = stored.flatMap((r) => {
    const payload = parseJson(r.payload)
    if (!payload || typeof payload.model_slug !== 'string') return []
    return [archivedRowView(r, payload)]
  })
  rows.sort((a, b) => byString(a.entity_key, b.entity_key))
  return { rows, captures }
}

function archivedRowView(
  r: typeof tables.archivedPrices.$inferSelect,
  payload: Record<string, unknown>,
): PriceRowView {
  return {
    entity_key: r.entity_key,
    source_id: archiveSourceId(r.capture_id),
    provider: r.provider as PriceRowView['provider'],
    model_slug: str(payload.model_slug) ?? '?',
    tier: str(payload.tier),
    context_window: str(payload.context_window),
    context_window_source: null,
    input_per_mtok: num(payload.input_per_mtok),
    cached_input_per_mtok: num(payload.cached_input_per_mtok),
    output_per_mtok: num(payload.output_per_mtok),
    effective_from: str(payload.effective_from),
    effective_until: str(payload.effective_until),
    notes: [str(payload.notes), ARCHIVE_SOURCE_NOTE].filter(Boolean).join(' '),
    removed: false,
    delta: null,
    also_listed_by: [],
    revisions: 1,
    spark: null,
    source_url: r.source_url,
    fetched_at: r.fetched_at,
    checked_at: null,
  }
}

/**
 * How far each lab's price history reaches: the archived span and how many
 * captures were read or skipped, and the first fetch of the lab's live
 * pricing sources. Two grouped reads and one row per source.
 */
export async function queryPriceReach(
  db: PipelineDb,
  registry: SourceRegistry,
): Promise<PriceReach[]> {
  const [archived, live] = await Promise.all([
    db
      .select({
        provider: tables.archiveCaptures.provider,
        status: tables.archiveCaptures.status,
        n: count(),
        from: min(tables.archiveCaptures.captured_at),
        until: max(tables.archiveCaptures.captured_at),
      })
      .from(tables.archiveCaptures)
      .where(eq(tables.archiveCaptures.axis, 'pricing'))
      .groupBy(tables.archiveCaptures.provider, tables.archiveCaptures.status),
    db
      .select({
        source_id: tables.sourceStats.source_id,
        first: tables.sourceStats.first_fetched_at,
      })
      .from(tables.sourceStats),
  ])
  const pricingSources = new Map(
    registry.sources
      .filter((s) => s.axis === 'pricing-catalog')
      .map((s) => [s.source_id, s.provider]),
  )
  const covered = new Set(ARCHIVE_ERAS.map((e) => e.provider as string))
  return PROVIDER_ORDER.map((provider) => {
    const parsed = archived.find((a) => a.provider === provider && a.status === 'parsed')
    const skipped = archived.find((a) => a.provider === provider && a.status === 'skipped')
    const liveFirst = live
      .filter((l) => pricingSources.get(l.source_id) === provider && l.first)
      .map((l) => l.first!)
      .sort()[0]
    return {
      provider,
      archived_from: parsed?.from ?? null,
      archived_until: parsed?.until ?? null,
      archived_parsed: parsed?.n ?? 0,
      archived_skipped: skipped?.n ?? 0,
      live_from: liveFirst ?? null,
      gaps: covered.has(provider)
        ? ARCHIVE_GAPS.filter((g) => g.provider === provider).map(({ from, until, reason }) => ({
            from,
            until,
            reason,
          }))
        : [],
      not_covered: ARCHIVE_NOT_COVERED.find((n) => n.provider === provider)?.reason ?? null,
    }
  })
}

// ---- events --------------------------------------------------------------------

/**
 * Launches and price changes the archived price lists show (price-events.ts),
 * before the live record starts. Each keeps its date window, so the harness
 * leaves a loosely dated one out of the short horizons.
 */
export async function archivedPriceEvents(db: PipelineDb): Promise<ArchivedPriceEvent[]> {
  const [captures, rows] = await Promise.all([
    db
      .select({
        id: tables.archiveCaptures.id,
        era: tables.archiveCaptures.era,
        provider: tables.archiveCaptures.provider,
        captured_at: tables.archiveCaptures.captured_at,
        source_url: tables.archiveCaptures.source_url,
      })
      .from(tables.archiveCaptures)
      .where(
        and(
          eq(tables.archiveCaptures.axis, 'pricing'),
          eq(tables.archiveCaptures.status, 'parsed'),
        ),
      ),
    db
      .select({
        capture_id: tables.archivedPrices.capture_id,
        entity_key: tables.archivedPrices.entity_key,
        payload: tables.archivedPrices.payload,
      })
      .from(tables.archivedPrices),
  ])
  const file = releaseNotes as ReleaseNotesFile
  return derivePriceEvents(captures, rows, file.notes, file.coverage).events.filter(
    (e) => e.date < LIVE_FROM,
  )
}

/** The parsed archived copies of the labs' rate-limit pages, oldest first. */
export async function archivedLimitCopies(db: PipelineDb) {
  const copies = await db
    .select({
      id: tables.archiveCaptures.id,
      provider: tables.archiveCaptures.provider,
      era: tables.archiveCaptures.era,
      captured_at: tables.archiveCaptures.captured_at,
      source_url: tables.archiveCaptures.source_url,
    })
    .from(tables.archiveCaptures)
    .where(
      and(eq(tables.archiveCaptures.axis, 'limits'), eq(tables.archiveCaptures.status, 'parsed')),
    )
    .orderBy(tables.archiveCaptures.captured_at)
  const recipes = new Map(LIMITS_ARCHIVE_ERAS.map((e) => [e.id, e.recipe_id]))
  return copies.flatMap((c) => {
    const recipe_id = recipes.get(c.era)
    return recipe_id ? [{ ...c, recipe_id }] : []
  })
}

/** Every limit that moved between consecutive archived copies (limit-events.ts). */
export async function archivedLimitChanges(db: PipelineDb): Promise<LimitChange[]> {
  const [copies, rows] = await Promise.all([
    archivedLimitCopies(db),
    db
      .select({
        capture_id: tables.archivedRateLimits.capture_id,
        recipe_id: tables.archivedRateLimits.recipe_id,
        key: tables.archivedRateLimits.key,
        model: tables.archivedRateLimits.model,
        tier: tables.archivedRateLimits.tier,
        metric: tables.archivedRateLimits.metric,
        value: tables.archivedRateLimits.value,
      })
      .from(tables.archivedRateLimits),
  ])
  return limitChanges(copies, rows, (releaseNotes as ReleaseNotesFile).notes)
}
