import { and, eq, inArray, lt, sql } from 'drizzle-orm'

import { LAB_DISPLAY } from '../../shared/utils/terminal-labs'

import * as tables from '#server/db/schema'
import { AlertRow, PriceRow, contentHash, type ChangeRow } from './contracts'
import type { PipelineDb } from './store'

// The model-floor rule: a model slug no vendor catalog in the store has
// listed before always alerts, with no model in the loop.
//
// A frontier launch is the event this terminal most needs to show on the day,
// and until this rule it depended on the hourly judge writing an alert. On
// the Opus 5.5 launch day the rows landed at 18:01 and five judge runs later
// no alert had been written. The judge still sees these changes and may add
// context, but the launch no longer waits on it.
//
// "New to the store" and not "added to this source". A pricing page that
// starts listing an old model, or a new tier of a known one, is the judge's
// to weigh. Only a slug the store did not list before this tick qualifies. A
// slug two catalogs add in the same tick alerts once: the first to parse
// writes the alert, and the second finds the first's rows already stored. The id hashes
// (provider, slug) alone, so a slug that is delisted and relisted never
// alerts twice either. A delisted slug also leaves the catalog rows, so the
// change log is read too: without it a model listed before this rule existed
// would be announced as new when it came back.

export const MODEL_FLOOR_RULE = 'model-floor' as const

/** A slug as vendors write them. Anything else is a parser reading a table
 * cell as a name; the judge still sees the row, but no launch is announced. */
const WELL_FORMED_SLUG = /^[a-z0-9][a-z0-9._-]*$/i

interface SlugChanges {
  provider: keyof typeof LAB_DISPLAY
  slug: string
  changes: ChangeRow[]
  rows: PriceRow[]
}

/** The added model rows of one tick, grouped by provider and slug. */
export function addedModels(changes: readonly ChangeRow[]): SlugChanges[] {
  const bySlug = new Map<string, SlugChanges>()
  for (const change of changes) {
    if (change.change_type !== 'added' || change.entity_type !== 'model' || !change.after_json) {
      continue
    }
    const row = PriceRow.parse({
      ...(JSON.parse(change.after_json) as Record<string, unknown>),
      source_url: change.source_url,
      fetched_at: change.fetched_at,
    })
    const key = `${row.provider}:${row.model_slug}`
    const group = bySlug.get(key) ?? {
      provider: row.provider,
      slug: row.model_slug,
      changes: [],
      rows: [],
    }
    group.changes.push(change)
    group.rows.push(row)
    bySlug.set(key, group)
  }
  return [...bySlug.values()]
}

/**
 * `provider:slug` for every model the store listed before this tick: every
 * source's rows except the ones this source just added. This source's older
 * rows count, so a new tier of a model the same page already listed is not
 * a launch.
 */
async function knownSlugs(
  db: PipelineDb,
  sourceId: string,
  providers: readonly string[],
  addedKeys: ReadonlySet<string>,
): Promise<Set<string>> {
  const rows = await db
    .select({
      source_id: tables.entities.source_id,
      entity_key: tables.entities.entity_key,
      provider: tables.entities.provider,
      payload: tables.entities.payload,
    })
    .from(tables.entities)
    .where(
      and(
        eq(tables.entities.entity_type, 'model'),
        inArray(tables.entities.provider, [...providers]),
      ),
    )
  const known = new Set<string>()
  for (const row of rows) {
    if (row.source_id === sourceId && addedKeys.has(row.entity_key)) continue
    const slug = (JSON.parse(row.payload) as { model_slug?: unknown }).model_slug
    if (typeof slug === 'string') known.add(`${row.provider}:${slug}`)
  }
  return known
}

/** `provider:slug` for every model the change log added before `before`. */
async function everAdded(
  db: PipelineDb,
  providers: readonly string[],
  before: string,
): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({
      provider: tables.changes.provider,
      slug: sql<string | null>`json_extract(${tables.changes.after_json}, '$.model_slug')`,
    })
    .from(tables.changes)
    .where(
      and(
        eq(tables.changes.entity_type, 'model'),
        eq(tables.changes.change_type, 'added'),
        inArray(tables.changes.provider, [...providers]),
        lt(tables.changes.detected_at, before),
      ),
    )
  return new Set(rows.flatMap((r) => (r.slug ? [`${r.provider}:${r.slug}`] : [])))
}

const usd = (n: number) => `$${n.toFixed(2)}`

// The headline's price is the list price: the standard tier, as the price
// matrix reads it (terminal-prices.ts › isStandardTier, scheduledAfter). Until
// 2026-11-11 this took the untiered row or else the first row parsed, and
// Google's parser names its list tier 'standard', so five Google launches were
// announced at their batch price (gemini-4-carbon at $1.00 / $5.00 against a
// $2.00 / $10.00 list price). Migration 0050 corrects those five.
const isStandard = (r: PriceRow) => r.tier === null || r.tier === 'standard'
const startsAfter = (r: PriceRow, at: string) =>
  r.effective_from !== null && Date.parse(r.effective_from) > Date.parse(at)
const bothPrices = (r: PriceRow) => r.input_per_mtok !== null && r.output_per_mtok !== null
const priceOf = (r: PriceRow) =>
  `${usd(r.input_per_mtok!)} in / ${usd(r.output_per_mtok!)} out per MTok`

/** "$5.00 in / $25.00 out per MTok": the standard-tier price in effect at `at`, or none. */
function priceClause(rows: readonly PriceRow[], at: string): string | null {
  const base = rows.find((r) => isStandard(r) && !startsAfter(r, at) && bothPrices(r))
  return base ? priceOf(base) : null
}

/** "Its standard price moves to … on 2026-12-01." for each scheduled standard price. */
function scheduledClause(rows: readonly PriceRow[], at: string): string {
  return rows
    .filter((r) => isStandard(r) && startsAfter(r, at) && bothPrices(r))
    .sort((a, b) => a.effective_from!.localeCompare(b.effective_from!))
    .map((r) => `Its standard price moves to ${priceOf(r)} on ${r.effective_from}. `)
    .join('')
}

export function modelFloorAlert(group: SlugChanges): AlertRow {
  const first = group.changes[0]!
  const lab = LAB_DISPLAY[group.provider]
  const price = priceClause(group.rows, first.detected_at)
  const tiers = [...new Set(group.rows.map((r) => r.tier ?? 'standard'))]
  return AlertRow.parse({
    id: contentHash({ rule: MODEL_FLOOR_RULE, provider: group.provider, slug: group.slug }),
    severity: 'notable',
    headline: `${lab} lists a new model, ${group.slug}${price ? ` — ${price}` : ''}`,
    explanation:
      `${group.slug} appears for the first time in ${lab}'s catalog (${first.source_url}), ` +
      `listed as ${tiers.join(', ')}. ` +
      scheduledClause(group.rows, first.detected_at) +
      'A model no catalog has listed before always alerts — the model-floor rule, no model in the loop.',
    change_ids: JSON.stringify(group.changes.map((c) => c.id)),
    rule: MODEL_FLOOR_RULE,
    created_at: first.detected_at,
    source_url: first.source_url,
    fetched_at: first.fetched_at,
  })
}

/** Floor alerts for one source's changes this tick, minus any already stored. */
export async function modelFloorAlerts(
  db: PipelineDb,
  sourceId: string,
  changes: readonly ChangeRow[],
): Promise<AlertRow[]> {
  const groups = addedModels(changes)
  if (groups.length === 0) return []
  const providers = [...new Set(groups.map((g) => g.provider))]
  const tick = groups.flatMap((g) => g.changes.map((c) => c.detected_at)).sort()[0]!
  const [known, history] = await Promise.all([
    knownSlugs(
      db,
      sourceId,
      providers,
      new Set(groups.flatMap((g) => g.changes.map((c) => c.entity_key))),
    ),
    everAdded(db, providers, tick),
  ])
  const fresh = groups
    .filter((g) => WELL_FORMED_SLUG.test(g.slug))
    .filter((g) => !known.has(`${g.provider}:${g.slug}`) && !history.has(`${g.provider}:${g.slug}`))
    .map(modelFloorAlert)
  if (fresh.length === 0) return []
  const stored = await db
    .select({ id: tables.alerts.id })
    .from(tables.alerts)
    .where(
      inArray(
        tables.alerts.id,
        fresh.map((a) => a.id),
      ),
    )
  const seen = new Set(stored.map((r) => r.id))
  return fresh.filter((a) => !seen.has(a.id))
}
