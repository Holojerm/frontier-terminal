import { and, eq, inArray } from 'drizzle-orm'

import { LAB_DISPLAY } from '#shared/utils/terminal-labs'

import * as tables from '../db/schema'
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
// alerts twice either.

export const MODEL_FLOOR_RULE = 'model-floor' as const

interface SlugChanges {
  provider: keyof typeof LAB_DISPLAY
  slug: string
  changes: ChangeRow[]
  rows: PriceRow[]
}

function addedModels(changes: readonly ChangeRow[]): SlugChanges[] {
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

const usd = (n: number) => `$${n.toFixed(2)}`

/** "$5.00 in / $25.00 out per MTok" off the untiered row, when it carries both prices. */
function priceClause(rows: readonly PriceRow[]): string | null {
  const base = rows.find((r) => r.tier === null) ?? rows[0]
  if (!base || base.input_per_mtok === null || base.output_per_mtok === null) return null
  return `${usd(base.input_per_mtok)} in / ${usd(base.output_per_mtok)} out per MTok`
}

export function modelFloorAlert(group: SlugChanges): AlertRow {
  const first = group.changes[0]!
  const lab = LAB_DISPLAY[group.provider]
  const price = priceClause(group.rows)
  const tiers = group.rows.map((r) => r.tier ?? 'standard')
  return AlertRow.parse({
    id: contentHash({ rule: MODEL_FLOOR_RULE, provider: group.provider, slug: group.slug }),
    severity: 'notable',
    headline: `${lab} lists a new model, ${group.slug}${price ? ` — ${price}` : ''}`,
    explanation:
      `${group.slug} appears for the first time in ${lab}'s catalog (${first.source_url}), ` +
      `listed as ${tiers.join(', ')}. ` +
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
  const known = await knownSlugs(
    db,
    sourceId,
    [...new Set(groups.map((g) => g.provider))],
    new Set(groups.flatMap((g) => g.changes.map((c) => c.entity_key))),
  )
  const fresh = groups.filter((g) => !known.has(`${g.provider}:${g.slug}`)).map(modelFloorAlert)
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
