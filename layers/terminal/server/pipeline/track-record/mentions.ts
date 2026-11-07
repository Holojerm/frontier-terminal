// The GKG rows kept for matching later. Each GKG file is read once, so an
// alert written after its files were read would never be matched against the
// press from before it: the half of its window where a lead would be. The job
// therefore also posts every row that carries a word from mentionVocabulary
// (a lab, a filer, a model family's first word), compacted to what
// matchesArticle reads, and the Worker keeps those MENTION_RETAIN_DAYS. When
// an alert is old enough that the job matches it going forward, its window is
// matched once against the kept rows (recordGkgFile › backfill).
//
// Measured on eight files across 2026-11-06: about 53 kept rows a file, 5,100
// a day, 1.5 MB a day compacted (78 MB verbatim, which is why rows are not
// kept whole).

import { and, eq, gte, isNull, lt, lte, max, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../store'
import { GKG_SLOT_MS, gkgStamp, stampIso } from './gkg'
import { mentionVocabulary, normalizeText } from './terms'
import { WINDOW_DAYS, type TrackWindow } from './window'

/** A window reaches WINDOW_DAYS before saw-it; a day more covers an alert written late. */
export const MENTION_RETAIN_DAYS = WINDOW_DAYS + 1

/** Kept rows one file may post. A file keeps ~50; this bounds a runaway vocabulary. */
export const MAX_MENTIONS_PER_FILE = 2_000

const DAY_MS = 86_400_000

export interface GkgMention {
  record_id: string
  outlet: string
  url: string
  title: string
  /** The vocabulary terms the row carried, in place of GDELT's whole names list. */
  names: string[]
}

/** The vocabulary for the model slugs on record today. */
export async function retentionVocabulary(db: PipelineDb): Promise<string[]> {
  const rows = await db
    .selectDistinct({
      slug: sql<string | null>`json_extract(${tables.entities.payload}, '$.model_slug')`,
    })
    .from(tables.entities)
    .where(eq(tables.entities.entity_type, 'model'))
  return mentionVocabulary(rows.map((r) => r.slug).filter((s): s is string => !!s))
}

/**
 * The posted rows the Worker keeps: a web URL, a title, and names that are all
 * vocabulary terms. The job reports what a row carried; the Worker cannot see
 * the file, so it bounds what a report may claim rather than re-reading it.
 */
export function acceptedMentions(
  mentions: readonly GkgMention[],
  vocabulary: readonly string[],
): GkgMention[] {
  const known = new Set(vocabulary.map((v) => normalizeText(v)))
  return mentions.filter(
    (m) =>
      /^https?:\/\//.test(m.url) &&
      m.title.trim().length > 0 &&
      m.names.length > 0 &&
      m.names.every((n) => known.has(normalizeText(n))),
  )
}

/** Keep one file's mentions; a row already kept (a re-post) is skipped. */
export async function storeMentions(
  db: PipelineDb,
  stamp: string,
  fetched_at: string,
  mentions: readonly GkgMention[],
): Promise<void> {
  const seen_at = stampIso(stamp)
  const rows = mentions.map((m) => ({
    record_id: m.record_id,
    stamp,
    seen_at,
    outlet: m.outlet,
    url: m.url,
    title: m.title,
    names: JSON.stringify(m.names),
    fetched_at,
  }))
  // Eight columns a row, under D1's hundred bound parameters a statement.
  for (let i = 0; i < rows.length; i += 12) {
    await db
      .insert(tables.gkgMentions)
      .values(rows.slice(i, i + 12))
      .onConflictDoNothing()
  }
}

/** Drop rows past MENTION_RETAIN_DAYS, measured from the file being recorded. */
export async function pruneMentions(db: PipelineDb, stamp: string): Promise<void> {
  const before = new Date(Date.parse(stampIso(stamp)) - MENTION_RETAIN_DAYS * DAY_MS).toISOString()
  await db.delete(tables.gkgMentions).where(lt(tables.gkgMentions.seen_at, before))
}

/** Kept rows from `from` through the quarter hour `through`, oldest first. */
export async function mentionsBetween(db: PipelineDb, from: string, through: string) {
  const rows = await db
    .select()
    .from(tables.gkgMentions)
    .where(
      and(
        gte(tables.gkgMentions.seen_at, from),
        lte(tables.gkgMentions.seen_at, stampIso(through)),
      ),
    )
    .orderBy(tables.gkgMentions.seen_at, tables.gkgMentions.record_id)
  return rows.map((r) => ({ ...r, names: JSON.parse(r.names) as string[] }))
}

/**
 * Where a backfilled alert's press search began: the window start, unless a
 * file in it up to the backfill was read before mentions were kept (an ok
 * file with mentions null); then just after the last such file. Null when the
 * alert was never backfilled or its terms fall outside the vocabulary.
 */
export async function backfilledFrom(
  db: PipelineDb,
  alertId: string,
  window: TrackWindow,
): Promise<string | null> {
  const [back] = await db
    .select()
    .from(tables.gkgBackfills)
    .where(eq(tables.gkgBackfills.alert_id, alertId))
  if (!back || !back.covered) return null
  const [gap] = await db
    .select({ stamp: max(tables.gdeltFiles.stamp) })
    .from(tables.gdeltFiles)
    .where(
      and(
        gte(tables.gdeltFiles.stamp, gkgStamp(Date.parse(window.start) - GKG_SLOT_MS + 1)),
        lte(tables.gdeltFiles.stamp, back.through_stamp),
        eq(tables.gdeltFiles.status, 'ok'),
        isNull(tables.gdeltFiles.mentions),
      ),
    )
  return gap?.stamp
    ? new Date(Date.parse(stampIso(gap.stamp)) + GKG_SLOT_MS).toISOString()
    : window.start
}
