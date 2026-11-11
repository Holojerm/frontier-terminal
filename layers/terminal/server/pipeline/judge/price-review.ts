import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'
import { contentHash, PriceRow, type EntityRow } from '../contracts'
import { diff, repeatChangeId } from '../diff'
import { normalizePrice } from '../normalize'
import { applyDiff, currentEntities, repeatedChangeIds, type PipelineDb } from '../store'
import type { RawReader } from './class-map'

// The judge's fallback for a price list whose parser is failing. A vendor
// reshapes its pricing page, the parser throws, and until the parser is fixed
// the terminal shows the last prices it read. Meanwhile GET /api/judge/pending
// offers the page as a PRICE REVIEW entry, and the judge sends back, per SKU
// the terminal already lists, the run of the page that states its prices.
//
// The model finds the row and says which number is which. The Worker decides,
// against the page as R2 holds it:
//   1. the source is still failing on that page, and the page was not read before;
//   2. the SKU is one this source already lists (no additions, no removals:
//      a launch is the catalog's job and a delisting needs a parser);
//   3. the quote is on the page verbatim (whitespace folded) and names the
//      model, and no longer-named model this source lists;
//   4. every price sent is written in the quote, and a price the row had is
//      still given (a reading cannot blank a price or invent a column).
// A price that differs is stored through the ordinary diff, so the change
// log, the judge and the alerts treat it as any other change, and the quote is
// kept in price_readings. Which column a number belongs to is the model's
// reading, so every changed price is spooled for the owner, and the fixed
// parser's first read corrects the row if it disagrees.

/**
 * The price lists the judge may read: the ones that print a model and its
 * prices on one table row, so check 3 pins a number to its model. Meta and
 * DeepSeek print a table per model with the prices down a column, and Google
 * a table per model under tabs; there a quote long enough to hold the name
 * and the prices holds other models' too, and nothing here could tell a
 * Contributor price from a Standard one. Those wait for the parser fix.
 */
export const PRICE_REVIEW_SOURCES: readonly string[] = [
  'openai-pricing-md',
  'anthropic-pricing-md',
  'mistral-pricing-md',
]

/** A page longer than this is not offered: a cut page reads as rows gone. */
export const PRICE_REVIEW_MAX_CHARS = 120_000

const price = z.number().nonnegative().nullable()

export const JudgePriceReading = z.strictObject({
  source_id: z.string().min(1).max(200),
  entity_key: z.string().min(1).max(300),
  quote: z.string().min(8).max(800),
  input_per_mtok: price,
  cached_input_per_mtok: price,
  output_per_mtok: price,
})
export type JudgePriceReading = z.infer<typeof JudgePriceReading>

const PRICE_FIELDS = ['input_per_mtok', 'cached_input_per_mtok', 'output_per_mtok'] as const
type Prices = Pick<PriceRow, (typeof PRICE_FIELDS)[number]>

export interface PriceReview {
  source_id: string
  source_url: string
  fetched_at: string
  /** Why the parser could not read the page. */
  error: string
  /** The SKUs to read, with the prices the terminal shows for them now. */
  known: ({ entity_key: string; model_slug: string; tier: string | null } & Prices)[]
  page: string
}

interface FailingPage {
  source_id: string
  error: string
  snapshot_id: string
  content_hash: string
  raw_key: string
  source_url: string
  fetched_at: string
}

const fold = (s: string) => s.replace(/\s+/g, ' ').trim()
const readingId = (sourceId: string, hash: string) =>
  contentHash({ price_reading: sourceId, page: hash })

/**
 * Sources whose last two runs both fetched a page and failed to parse it, and
 * whose newest page has no reading yet. Two runs, so one bad response (a
 * half-rendered page, a refused mass removal the next fetch confirms) is not
 * sent to the judge.
 */
async function failingPages(db: PipelineDb): Promise<FailingPage[]> {
  const out: FailingPage[] = []
  for (const source_id of PRICE_REVIEW_SOURCES) {
    const runs = await db
      .select({
        status: tables.sourceRuns.status,
        detail: tables.sourceRuns.detail,
        snapshot_id: tables.sourceRuns.snapshot_id,
      })
      .from(tables.sourceRuns)
      .where(eq(tables.sourceRuns.source_id, source_id))
      .orderBy(desc(tables.sourceRuns.started_at))
      .limit(2)
    const [newest] = runs
    if (runs.length < 2 || !runs.every((r) => r.status === 'failed' && r.snapshot_id)) continue
    const [snapshot] = await db
      .select()
      .from(tables.snapshots)
      .where(eq(tables.snapshots.id, newest!.snapshot_id!))
    if (!snapshot) continue
    const [read] = await db
      .select({ id: tables.priceReadings.id })
      .from(tables.priceReadings)
      .where(eq(tables.priceReadings.id, readingId(source_id, snapshot.content_hash)))
    if (read) continue
    out.push({
      source_id,
      error: newest!.detail ?? 'unknown failure',
      snapshot_id: snapshot.id,
      content_hash: snapshot.content_hash,
      raw_key: snapshot.raw_key,
      source_url: snapshot.source_url,
      fetched_at: snapshot.fetched_at,
    })
  }
  return out
}

interface Known {
  entity: EntityRow
  /** The stored row, without its provenance. */
  content: Omit<PriceRow, 'source_url' | 'fetched_at'>
}

async function knownPrices(db: PipelineDb, sourceId: string): Promise<Map<string, Known>> {
  const out = new Map<string, Known>()
  for (const entity of await currentEntities(db, sourceId)) {
    if (entity.entity_type !== 'model') continue
    const content = PriceRow.omit({ source_url: true, fetched_at: true }).safeParse(
      JSON.parse(entity.payload),
    )
    if (content.success) out.set(entity.entity_key, { entity, content: content.data })
  }
  return out
}

/** The PRICE REVIEW block: each failing price list, its page and the SKUs to read from it. */
export async function priceReview(db: PipelineDb, readRaw: RawReader): Promise<PriceReview[]> {
  const out: PriceReview[] = []
  for (const failing of await failingPages(db)) {
    const page = await readRaw(failing.raw_key)
    if (page === null || page.length > PRICE_REVIEW_MAX_CHARS) continue
    const known = await knownPrices(db, failing.source_id)
    if (!known.size) continue
    out.push({
      source_id: failing.source_id,
      source_url: failing.source_url,
      fetched_at: failing.fetched_at,
      error: failing.error,
      known: [...known].map(([entity_key, { content }]) => ({
        entity_key,
        model_slug: content.model_slug,
        tier: content.tier,
        input_per_mtok: content.input_per_mtok,
        cached_input_per_mtok: content.cached_input_per_mtok,
        output_per_mtok: content.output_per_mtok,
      })),
      page,
    })
  }
  return out
}

const tokens = (slug: string) =>
  slug
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

/**
 * Whether the text names the model: the slug's words in order, as whole
 * words, and not running on into a longer version ("opus 5" in "Opus 5.5").
 */
export function namesModel(text: string, slug: string): boolean {
  const words = tokens(slug)
  if (!words.length) return false
  const run = words.join('[^a-z0-9]{0,3}')
  return new RegExp(`(?<![a-z0-9])${run}(?![a-z0-9]|[.-]\\d)`).test(text.toLowerCase())
}

/** Every number the text writes, thousands separators dropped. */
function numbersIn(text: string): Set<number> {
  return new Set(
    [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))),
  )
}

/** Why a reading does not hold against the page, or the prices it reads. */
export function checkPriceReading(
  reading: JudgePriceReading,
  page: string,
  known: Pick<PriceRow, 'model_slug'> & Prices,
  /** The slugs of the other SKUs this source lists. */
  otherSlugs: readonly string[],
): { ok: true; prices: Prices } | { ok: false; reason: string; detail: string } {
  const quote = fold(reading.quote)
  if (!fold(page).includes(quote))
    return { ok: false, reason: 'quote-not-on-page', detail: quote.slice(0, 120) }
  if (!namesModel(quote, known.model_slug))
    return { ok: false, reason: 'quote-names-no-such-model', detail: known.model_slug }
  const mine = tokens(known.model_slug).length
  const longer = otherSlugs.find(
    (slug) =>
      slug !== known.model_slug &&
      tokens(slug).length > mine &&
      namesModel(slug, known.model_slug) &&
      namesModel(quote, slug),
  )
  if (longer) return { ok: false, reason: 'quote-names-another-model', detail: longer }
  const written = numbersIn(quote)
  for (const field of PRICE_FIELDS) {
    const value = reading[field]
    if ((value === null) !== (known[field] === null))
      return { ok: false, reason: 'price-columns-changed', detail: field }
    if (value !== null && !written.has(value))
      return { ok: false, reason: 'price-not-in-quote', detail: `${field} ${value}` }
  }
  return {
    ok: true,
    prices: {
      input_per_mtok: reading.input_per_mtok,
      cached_input_per_mtok: reading.cached_input_per_mtok,
      output_per_mtok: reading.output_per_mtok,
    },
  }
}

export interface PriceReport {
  /** Readings that held, whether or not the price moved. */
  accepted: number
  /** Of those, the SKUs whose stored price changed. */
  changed: number
  rejected: { reason: string; detail: string; source_id: string }[]
}

/** Gate the price readings of one judge run and store the prices that moved. */
export async function applyPriceReadings(
  db: PipelineDb,
  readRaw: RawReader,
  readings: readonly JudgePriceReading[],
  now: Date,
): Promise<PriceReport> {
  const report: PriceReport = { accepted: 0, changed: 0, rejected: [] }
  if (!readings.length) return report
  const offered = new Map((await failingPages(db)).map((f) => [f.source_id, f]))
  const bySource = new Map<string, JudgePriceReading[]>()
  for (const r of readings) bySource.set(r.source_id, [...(bySource.get(r.source_id) ?? []), r])

  for (const [source_id, group] of bySource) {
    const reject = (reason: string, detail: string) =>
      report.rejected.push({ reason, detail, source_id })
    const failing = offered.get(source_id)
    if (!failing) {
      reject('not-offered', `${group.length} reading(s)`)
      continue
    }
    const page = await readRaw(failing.raw_key)
    if (page === null) {
      reject('page-not-stored', failing.raw_key)
      continue
    }
    const known = await knownPrices(db, source_id)
    const slugs = [...new Set([...known.values()].map((k) => k.content.model_slug))]
    const prov = { source_url: failing.source_url, fetched_at: failing.fetched_at }
    const held: { entity_key: string; quote: string; prices: Prices }[] = []
    const before: EntityRow[] = []
    const after: EntityRow[] = []
    for (const r of group) {
      const row = known.get(r.entity_key)
      if (!row || held.some((h) => h.entity_key === r.entity_key)) {
        reject(row ? 'read-twice' : 'not-a-listed-sku', r.entity_key)
        continue
      }
      const result = checkPriceReading(r, page, row.content, slugs)
      if (!result.ok) {
        reject(result.reason, `${result.detail} (${r.entity_key})`)
        continue
      }
      held.push({ entity_key: r.entity_key, quote: fold(r.quote), prices: result.prices })
      if (PRICE_FIELDS.every((f) => result.prices[f] === row.content[f])) continue
      before.push(row.entity)
      after.push(
        normalizePrice(
          PriceRow.parse({ ...row.content, ...result.prices, ...prov }),
          failing.snapshot_id,
        ),
      )
    }
    if (!held.length) continue

    const { changes: found, upserts } = diff(before, after, failing.fetched_at, failing.source_url)
    const repeats = await repeatedChangeIds(db, found)
    const changes = found.map((c) => (repeats.has(c.id) ? repeatChangeId(c) : c))
    if (upserts.length) {
      await applyDiff(db, source_id, {
        upserts: upserts.map((row) => ({ ...row, source_id, first_seen_at: row.fetched_at })),
        removed: [],
        changes,
        alerts: [],
      })
      await recordOpsEvent(db, {
        kind: 'price_read_by_judge',
        detail: `${source_id}: ${upserts.length} price(s) changed from the judge's reading while the parser is failing — ${upserts.map((u) => u.entity_key).join(', ')}`,
        path: failing.source_url,
      })
    }
    const moved = new Set(upserts.map((u) => u.entity_key))
    await db
      .insert(tables.priceReadings)
      .values({
        id: readingId(source_id, failing.content_hash),
        source_id,
        snapshot_id: failing.snapshot_id,
        content_hash: failing.content_hash,
        confirmed: held.length - moved.size,
        changed: moved.size,
        readings: JSON.stringify(held.filter((h) => moved.has(h.entity_key))),
        source_url: failing.source_url,
        fetched_at: failing.fetched_at,
        read_at: now.toISOString(),
      })
      .onConflictDoNothing()
    report.accepted += held.length
    report.changed += moved.size
  }
  return report
}
