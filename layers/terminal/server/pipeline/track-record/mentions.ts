// The GKG rows the press side matches against. Each GKG file is read once,
// in order (scripts/gdelt-search.ts), and of each the Worker keeps only the
// rows that carry a word from mentionVocabulary (a lab, a filer, a model
// family's first word), compacted to what matchesArticle reads. Nothing is
// matched as a file is read: when an alert's window closes, the cron matches
// it once against the rows kept for that window (search.ts ›
// runTrackRecordSearch), so the press from before the alert was written is
// searched like the press after it.
//
// The kept rows hold every match only where the vocabulary covered the
// alert's terms (termsInVocabulary). The vocabulary grows: a model family's
// first word joins it when its first model is stored, so the files read
// before then kept no row for that family. Each file therefore records the
// vocabulary it was read with, and pressSearchedFrom checks the alert against
// each file's own.
//
// Measured on eight files across 2026-11-06: about 53 kept rows a file, 5,100
// a day, 1.5 MB a day compacted (78 MB verbatim, which is why rows are not
// kept whole).

import { and, eq, gte, lt, lte, max, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../store'
import { GKG_SLOT_MS, gkgStamp, stampIso } from './gkg'
import { mentionVocabulary, normalizeText, termsInVocabulary, type SearchTerms } from './terms'
import { WINDOW_DAYS, type TrackWindow } from './window'

const DAY_MS = 86_400_000

/**
 * Rows are kept this long, measured from the Worker's clock: a whole window
 * and a day, so a window is still held when its search row is written, which
 * is as soon as its last file is read. A fixed span rather than one that
 * follows the alerts still waiting: some alert nearly always is, with its
 * window starting about two weeks back, so that would keep as much, and this
 * needs no alert list where it prunes and only the clock where it checks.
 */
export const MENTION_RETAIN_DAYS = 2 * WINDOW_DAYS + 1

/** Kept rows one file may post. A file keeps ~50; this bounds a runaway vocabulary. */
export const MAX_MENTIONS_PER_FILE = 2_000

export interface GkgMention {
  record_id: string
  outlet: string
  url: string
  title: string
  /** The vocabulary terms the row carried, in place of GDELT's whole names list. */
  names: string[]
}

/** The vocabulary for the model slugs on record now. */
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
 * The posted rows the Worker keeps, with only the names in `vocabulary`: a web
 * URL, a title, and at least one such name. The job reports what a row
 * carried; the Worker cannot see the file, so it bounds what a report may
 * claim rather than re-reading it. A name the vocabulary has since lost (a
 * delisted model) is dropped, so what is kept is what `vocabulary` alone
 * would have kept.
 */
export function acceptedMentions(
  mentions: readonly GkgMention[],
  vocabulary: readonly string[],
): GkgMention[] {
  const known = new Set(vocabulary.map((v) => normalizeText(v)))
  return mentions.flatMap((m) => {
    const names = m.names.filter((n) => known.has(normalizeText(n)))
    return /^https?:\/\//.test(m.url) && m.title.trim().length > 0 && names.length > 0
      ? [{ ...m, names }]
      : []
  })
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

/** The earliest quarter hour whose kept rows are certainly all still held at `now`. */
const keptSince = (now: Date) => now.getTime() - MENTION_RETAIN_DAYS * DAY_MS

/** Drop rows past MENTION_RETAIN_DAYS. */
export async function pruneMentions(db: PipelineDb, now: Date): Promise<void> {
  const before = new Date(keptSince(now)).toISOString()
  await db.delete(tables.gkgMentions).where(lt(tables.gkgMentions.seen_at, before))
}

export type KeptMention = Omit<typeof tables.gkgMentions.$inferSelect, 'names'> & {
  names: string[]
}

/**
 * The kept rows inside a window, oldest first, a day's worth per query so a
 * caller that stops early reads no more than it needs.
 */
export async function* mentionsIn(
  db: PipelineDb,
  window: TrackWindow,
): AsyncGenerator<KeptMention> {
  const end = Date.parse(window.end)
  for (let t = Date.parse(window.start); t <= end; t += DAY_MS) {
    const rows = await db
      .select()
      .from(tables.gkgMentions)
      .where(
        and(
          gte(tables.gkgMentions.seen_at, new Date(t).toISOString()),
          t + DAY_MS > end
            ? lte(tables.gkgMentions.seen_at, window.end)
            : lt(tables.gkgMentions.seen_at, new Date(t + DAY_MS).toISOString()),
        ),
      )
      .orderBy(tables.gkgMentions.seen_at, tables.gkgMentions.record_id)
    for (const r of rows) yield { ...r, names: JSON.parse(r.names) as string[] }
  }
}

/**
 * Where an alert's press search actually began: the window's start when every
 * file in it kept its rows by a vocabulary that covers the alert's terms,
 * otherwise the first instant after the last file that did not (one read
 * before rows were kept, or whose vocabulary lacked the alert's words), or
 * whose rows may have been pruned by `now`. The page leaves a window searched
 * only in part out of the lead/lag tally.
 */
export async function pressSearchedFrom(
  db: PipelineDb,
  terms: SearchTerms,
  window: TrackWindow,
  now: Date,
): Promise<string> {
  // One row per distinct vocabulary, so a window's ~1,350 files cost a handful of checks.
  const groups = await db
    .select({ vocabulary: tables.gdeltFiles.vocabulary, last: max(tables.gdeltFiles.stamp) })
    .from(tables.gdeltFiles)
    .where(
      and(
        gte(tables.gdeltFiles.stamp, gkgStamp(Date.parse(window.start) - GKG_SLOT_MS + 1)),
        lte(tables.gdeltFiles.stamp, gkgStamp(Date.parse(window.end))),
        eq(tables.gdeltFiles.status, 'ok'),
      ),
    )
    .groupBy(tables.gdeltFiles.vocabulary)
  let from = Math.max(Date.parse(window.start), keptSince(now))
  for (const g of groups) {
    const covered =
      g.vocabulary !== null && termsInVocabulary(terms, JSON.parse(g.vocabulary) as string[])
    if (!covered && g.last) from = Math.max(from, Date.parse(stampIso(g.last)) + GKG_SLOT_MS)
  }
  return new Date(Math.min(from, Date.parse(window.end))).toISOString()
}
