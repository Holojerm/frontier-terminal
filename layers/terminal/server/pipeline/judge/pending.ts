import { and, gte, isNotNull, notInArray, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { ChangeRow } from '../contracts'
import type { PipelineDb } from '../store'

// What GET /api/judge/pending hands the routine: change rows detected since
// the last judged run, minus the ones that only say "the board re-stamped
// its timestamps" and the tripwire hits on filers nobody here tracks, oldest
// first and capped.
//
// Nothing is deleted by either filter. The rows stay in `changes`, in the
// export and on every public endpoint; they just do not wake the judge.

/**
 * Cap on what one judge run considers, taken oldest first. Changes the model
 * stays SILENT about are never cited, so without a cursor every run would
 * re-send the whole history; with the cursor a cap still matters for a run
 * over a backlog, where a bounded prompt beats an exhaustive one. Oldest
 * first because the cursor moves to the newest change offered: a newest-first
 * cap moved it past everything the cap left out, which was then never judged.
 * The route reports total_pending so a bite of the cap is never silent.
 */
export const JUDGE_CHANGE_LIMIT = 200

/**
 * Normalized-payload fields a job board rewrites without changing the
 * posting. The names are the parser output's (layers/terminal/server/pipeline/parsers/hiring):
 * Ashby's `publishedAt` lands as `published_at`, and Greenhouse's
 * `first_published` / `updated_at` as `published_at` / `updated_at`.
 */
export const JOB_TIMESTAMP_FIELDS = ['published_at', 'updated_at'] as const

/**
 * Per entity type, the payload fields a source re-stamps without the entry
 * changing. A disclosure index prints a "Report updated" date that moves on
 * any revision; the row keeps it (the earliest one is the publication date),
 * but a change there alone is not news. Model and filing rows carry no such
 * field.
 */
export const TIMESTAMP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  job: JOB_TIMESTAMP_FIELDS,
  disclosure: ['listed_on'],
}

/**
 * Entity types the judge never sees. 'ranking' rows are a time series — one
 * (UTC day, model) observation each, ~50 new rows a day by construction — not
 * events; offering them would wake the judge every morning to read a table.
 * Demand-share movement is read off /api/rankings instead. The same set is
 * excluded from the signal band's counts (layers/terminal/server/utils/terminal-db.ts).
 */
// 'filed_fact' changes exist only as the citation of a rule-based alert that
// is already written (layers/terminal/server/exposure/alerts.ts).
export const JUDGE_EXCLUDED_ENTITY_TYPES = ['ranking', 'filed_fact'] as const

/** The WHERE fragment that keeps excluded entity types out of a changes query. */
export const judgeEligible = () =>
  notInArray(tables.changes.entity_type, [...JUDGE_EXCLUDED_ENTITY_TYPES])

/** A `modified` whose before/after differ only in its type's TIMESTAMP_FIELDS.
 * Typed on plain strings so a raw D1 row qualifies without a parse. */
export function isTimestampOnlyChange(change: {
  entity_type: string
  change_type: string
  before_json: string | null
  after_json: string | null
}): boolean {
  const fields = TIMESTAMP_FIELDS[change.entity_type]
  if (!fields || change.change_type !== 'modified') return false
  if (change.before_json === null || change.after_json === null) return false
  const strip = (json: string) => {
    const value = JSON.parse(json) as Record<string, unknown>
    for (const field of fields) delete value[field]
    return value
  }
  return stableEquals(strip(change.before_json), strip(change.after_json))
}

/**
 * A `filing` change about a company this terminal does not track.
 *
 * The two EDGAR full-text tripwires sweep every filer for the words
 * "Anthropic" and "OpenAI", and sources.yaml records the verdict on that
 * plainly: "Open keyword sweeps across all filers are confirmed noisy
 * (micro-cap false positives) — whitelist only." A micro-cap whose S-1 names
 * a lab in its risk factors is a hit, and the row is kept — the tripwire only
 * works because every hit is stored and diffed. What it is not is an event
 * about a frontier lab.
 *
 * The deterministic rules already read it that way: s1-floor alerts on
 * whitelisted rows only. The judge did not, and the prompt tells it every
 * filing record is alert-worthy, so it wrote headlines like "Oura Inc. (OURA)
 * files S-1/A matching an EDGAR full-text search for 'Anthropic'" — where the
 * only thing tying the filing to a lab was the query, which is not in the
 * record. The grounding gate rejected them, correctly, five times in two
 * weeks. This stops them being offered in the first place.
 *
 * `whitelist_cik` is the discriminator, and it is safe to filter on: a
 * submissions or company-facts feed is only ever derived for a CIK that is
 * already whitelisted or resolved, so those rows always carry one. A lab's
 * OWN first S-1 arrives before it is whitelisted and so is filtered here —
 * and is exactly what the deterministic cik-resolved rule fires on
 * (layers/terminal/server/pipeline/lanes.ts), at `critical`, with no model in the loop. From
 * the next poll the lab is whitelisted and its filings reach the judge.
 */
export function isUntrackedFilingChange(change: {
  entity_type: string
  before_json: string | null
  after_json: string | null
}): boolean {
  if (change.entity_type !== 'filing') return false
  // A removal carries its row in before_json; everything else in after_json.
  const json = change.after_json ?? change.before_json
  if (json === null) return false
  const row = JSON.parse(json) as { whitelist_cik?: unknown }
  return row.whitelist_cik === null || row.whitelist_cik === undefined
}

function stableEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ak = Object.keys(a).sort()
  const bk = Object.keys(b).sort()
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false
  return ak.every((k) =>
    stableEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  )
}

/** The newest judged_through across judge_runs, or null before the first run. */
export async function judgedThrough(db: PipelineDb): Promise<string | null> {
  // Ordered by instant, not by string: a cursor written without milliseconds
  // ("…:00Z") sorts after a later one written with them ("…:00.500Z").
  const [row] = await db
    .select({ at: tables.judgeRuns.judged_through })
    .from(tables.judgeRuns)
    .where(isNotNull(tables.judgeRuns.judged_through))
    .orderBy(sql`julianday(${tables.judgeRuns.judged_through}) desc`)
    .limit(1)
  return row?.at ?? null
}

const DAY_MS = 86_400_000

/**
 * The WHERE fragment for "detected after the cursor", compared as instants.
 * The string bound a day early keeps the detected_at index in play (it holds
 * for any offset a timestamp may carry); julianday() is the exact test, since
 * a string comparison misorders "…:00Z" against "…:00.500Z".
 */
export function detectedAfter(since: string | null) {
  if (since === null) return undefined
  const floor = new Date(Date.parse(since) - DAY_MS).toISOString().slice(0, 10)
  return and(
    gte(tables.changes.detected_at, floor),
    sql`julianday(${tables.changes.detected_at}) > julianday(${since})`,
  )
}

/**
 * How many of `times` (detected_at instants, oldest first) one run is
 * offered: up to `limit`, cut back to an instant boundary. The routine
 * advances the cursor to the newest offered instant, so a cut inside one
 * would strand that instant's other rows behind the cursor for good. One
 * instant holding more than `limit` rows (a new source's first poll) is
 * offered whole rather than not at all.
 */
export function offerCount(times: readonly number[], limit: number): number {
  if (times.length <= limit) return times.length
  let n = limit
  while (n > 0 && times[n] === times[n - 1]) n--
  if (n > 0) return n
  n = limit
  while (n < times.length && times[n] === times[n - 1]) n++
  return n
}

export interface PendingChanges {
  changes: ChangeRow[]
  /** Pending after both filters, before the cap. */
  total_pending: number
  /** The cursor the selection started from; null on the first run. */
  since: string | null
  /** The newest detected_at offered: the judged_through this run should send. Null when nothing is. */
  through: string | null
}

export async function pendingChanges(
  db: PipelineDb,
  limit: number = JUDGE_CHANGE_LIMIT,
): Promise<PendingChanges> {
  const since = await judgedThrough(db)
  const rows = await db
    .select()
    .from(tables.changes)
    .where(and(judgeEligible(), detectedAfter(since)))
  const pending = rows
    .filter((row) => !isTimestampOnlyChange(row) && !isUntrackedFilingChange(row))
    .map((row) => ({ row, at: Date.parse(row.detected_at) }))
    .sort((a, b) => a.at - b.at || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0))
  const offered = pending.slice(
    0,
    offerCount(
      pending.map((p) => p.at),
      limit,
    ),
  )
  return {
    changes: offered.map((p) => ChangeRow.parse(p.row)),
    total_pending: pending.length,
    since,
    through: offered.at(-1)?.row.detected_at ?? null,
  }
}
