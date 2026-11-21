// Figure headlines from GDELT's GKG files before GKG_FROM, so press reports
// that ran before a filing can be scored against it (Anthropic's S-1 prints
// revenue back to 2023). Reading every file back to ARCHIVE_FROM is ~900 GB
// for a few thousand headlines (docs/source-audit.md, 2026-11-20), so the
// archive is read in two passes:
//
//   scout  the first file of every hour, every day: 24 of each day's 96
//   fill   the other 72 quarter hours of each day whose scout files carried
//          figure headlines (hotDays), and of the day either side, since a
//          story's copies spread over a day or two and leaks run ahead of it
//
// A day is decided on its scout files alone, so what the fill reads can't
// widen the fill. The Worker hands out the files (archiveWork) after the live
// files and the figure backlog are read, and keeps only figure headlines
// (recordArchiveFile): no mention is stored, so no alert is matched against an
// archive file. The job posts each pass's files in order, so the last one
// recorded says how far that pass has read.

import { and, eq, gte, lt, max } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import { GKG_FROM, GKG_SLOT_MS, gkgStamp, gkgUrl, stampIso } from '../track-record/gkg'
import { storeFigureRows, type FigureRow, type FigureRowsOutcome } from './store'

/** The first day read: Microsoft's OpenAI investment (January 2023) and the year Anthropic's S-1 starts with. */
export const ARCHIVE_FROM = '2023-01-01T00:00:00.000Z'

/** Files handed out per /api/gdelt/work call: a day's worth, under a minute of the job's reading. */
export const ARCHIVE_FILES_PER_CALL = 96

/** Distinct figure headlines a day's scout files must carry for the day to be filled. */
export const ARCHIVE_HOT_HEADLINES = 2

/** Days filled either side of a hot day. */
export const ARCHIVE_WINDOW_DAYS = 1

/** A revenue headline is what the ground truth scores against a filing, so one alone makes a day hot. */
const REVENUE_WORDS = /\b(revenues?|sales|run[- ]rate|annuali[sz]ed|ARR)\b/i

export type ArchivePass = 'scout' | 'fill'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** A scout file is an hour's first quarter hour. */
export const passOf = (stamp: string): ArchivePass =>
  stamp.slice(10, 12) === '00' ? 'scout' : 'fill'

const archiveStart = () => Date.parse(ARCHIVE_FROM)
const archiveEnd = () => Date.parse(GKG_FROM)

/** A quarter hour's stamp inside the archive span, or false. */
export function inArchive(stamp: string): boolean {
  if (!/^\d{14}$/.test(stamp)) return false
  const t = Date.parse(stampIso(stamp))
  return (
    Number.isFinite(t) &&
    t % GKG_SLOT_MS === 0 &&
    gkgStamp(t) === stamp &&
    t >= archiveStart() &&
    t < archiveEnd()
  )
}

/** The scout files after `last` (or from ARCHIVE_FROM), oldest first. */
export function scoutStamps(last: string | null, limit: number): string[] {
  const out: string[] = []
  const from = last ? Date.parse(stampIso(last)) + HOUR_MS : archiveStart()
  for (let t = from; t < archiveEnd() && out.length < limit; t += HOUR_MS) out.push(gkgStamp(t))
  return out
}

export interface ArchiveArticle {
  published_at: string
  title_key: string
  title: string
}

/**
 * The days (YYYY-MM-DD, UTC) whose scout files carried ARCHIVE_HOT_HEADLINES
 * distinct figure headlines, or one that states revenue. Only scout articles
 * count, and only those before GKG_FROM.
 */
export function hotDays(articles: readonly ArchiveArticle[]): string[] {
  const byDay = new Map<string, { keys: Set<string>; revenue: boolean }>()
  for (const a of articles) {
    const t = Date.parse(a.published_at)
    if (!(t >= archiveStart() && t < archiveEnd()) || passOf(gkgStamp(t)) !== 'scout') continue
    const day = a.published_at.slice(0, 10)
    const held = byDay.get(day) ?? { keys: new Set<string>(), revenue: false }
    held.keys.add(a.title_key)
    held.revenue ||= REVENUE_WORDS.test(a.title)
    byDay.set(day, held)
  }
  return [...byDay]
    .filter(([, d]) => d.revenue || d.keys.size >= ARCHIVE_HOT_HEADLINES)
    .map(([day]) => day)
    .sort()
}

/** Each hot day with ARCHIVE_WINDOW_DAYS either side, inside the archive span, oldest first. */
export function fillDays(hot: readonly string[]): string[] {
  const days = new Set<string>()
  for (const day of hot) {
    const t = Date.parse(`${day}T00:00:00Z`)
    for (let d = -ARCHIVE_WINDOW_DAYS; d <= ARCHIVE_WINDOW_DAYS; d++) {
      const at = t + d * DAY_MS
      if (at >= archiveStart() && at < archiveEnd())
        days.add(new Date(at).toISOString().slice(0, 10))
    }
  }
  return [...days].sort()
}

/** The fill files of `days` after `last`, oldest first: every quarter hour the scout didn't read. */
export function fillStamps(days: readonly string[], last: string | null, limit: number): string[] {
  const out: string[] = []
  for (const day of days) {
    const t0 = Date.parse(`${day}T00:00:00Z`)
    if (last && gkgStamp(t0 + DAY_MS - GKG_SLOT_MS) <= last) continue
    for (let t = t0; t < t0 + DAY_MS; t += GKG_SLOT_MS) {
      const stamp = gkgStamp(t)
      if (passOf(stamp) === 'fill' && (!last || stamp > last)) out.push(stamp)
      if (out.length >= limit) return out
    }
  }
  return out
}

async function lastOf(db: PipelineDb, pass: ArchivePass): Promise<string | null> {
  const [row] = await db
    .select({ stamp: max(tables.gdeltArchiveFiles.stamp) })
    .from(tables.gdeltArchiveFiles)
    .where(eq(tables.gdeltArchiveFiles.pass, pass))
  return row?.stamp ?? null
}

/** The next archive files to read: the scout's until it reaches GKG_FROM, then the fill's. */
export async function archiveWork(
  db: PipelineDb,
  limit: number = ARCHIVE_FILES_PER_CALL,
): Promise<{ stamp: string; url: string }[]> {
  const toFiles = (stamps: string[]) => stamps.map((stamp) => ({ stamp, url: gkgUrl(stamp) }))
  const scout = scoutStamps(await lastOf(db, 'scout'), limit)
  if (scout.length) return toFiles(scout)
  const articles = await db
    .select({
      published_at: tables.reportedArticles.published_at,
      title_key: tables.reportedArticles.title_key,
      title: tables.reportedArticles.title,
    })
    .from(tables.reportedArticles)
    .where(
      and(
        gte(tables.reportedArticles.published_at, ARCHIVE_FROM),
        lt(tables.reportedArticles.published_at, GKG_FROM),
      ),
    )
  return toFiles(fillStamps(fillDays(hotDays(articles)), await lastOf(db, 'fill'), limit))
}

export interface ArchiveFileInput {
  stamp: string
  fetched_at: string
  /** missing: GDELT answered 404 for that quarter hour. */
  status: 'ok' | 'missing'
  rows: number
  figures: readonly FigureRow[]
}

export type ArchiveFileOutcome =
  | ({ recorded: true } & FigureRowsOutcome)
  | { recorded: false; reason: 'outside-archive' | 'already-read' }

/** Store the figure headlines of one archive file, once. Every headline is matched again (storeFigureRows). */
export async function recordArchiveFile(
  db: PipelineDb,
  input: ArchiveFileInput,
  now: Date,
): Promise<ArchiveFileOutcome> {
  if (!inArchive(input.stamp)) return { recorded: false, reason: 'outside-archive' }
  const [held] = await db
    .select({ stamp: tables.gdeltArchiveFiles.stamp })
    .from(tables.gdeltArchiveFiles)
    .where(eq(tables.gdeltArchiveFiles.stamp, input.stamp))
  if (held) return { recorded: false, reason: 'already-read' }
  const ok = input.status === 'ok'
  const outcome = ok
    ? await storeFigureRows(
        db,
        { stamp: input.stamp, fetched_at: input.fetched_at, rows: input.figures },
        now,
      )
    : { articles: 0, rejected: input.figures.length }
  await db
    .insert(tables.gdeltArchiveFiles)
    .values({
      stamp: input.stamp,
      pass: passOf(input.stamp),
      status: input.status,
      rows: ok ? input.rows : 0,
      figures: outcome.articles,
      fetched_at: input.fetched_at,
      recorded_at: now.toISOString(),
    })
    .onConflictDoNothing()
  return { recorded: true, ...outcome }
}
