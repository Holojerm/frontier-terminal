// Storing figure headlines from the GDELT GKG files. Two ways in: a file read
// for the first time, whose kept rows (../track-record/mentions.ts) recordGkgFile
// passes here, since a figure headline names a lab and so is always one of them;
// and a file read before this side existed, read again for figures only
// (recordFigureFile). Either way the Worker matches each headline again with
// figureHeadline, so the job can't choose what is kept.

import { and, asc, eq, isNull } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { contentHash } from '../contracts'
import { D1_MAX_BOUND_PARAMS, chunk, type PipelineDb } from '../store'
import { gkgUrl, stampIso } from '../track-record/gkg'
import { figureHeadline } from './figures'

/** Figure headlines one file may post. A file holds a handful; this bounds a runaway match. */
export const MAX_FIGURES_PER_FILE = 200

/** Files handed out per backfill call: about two minutes of the job's reading. */
export const FIGURE_FILES_PER_CALL = 24

export const articleId = (url: string) => contentHash({ url })

/** One headline, one key: a wire story on fifty sites is read once. Same key as the track record's. */
export const titleKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** A GKG row as the job reports it: what reported_articles keeps of it. */
export interface FigureRow {
  record_id: string
  outlet: string
  url: string
  title: string
}

export interface FigureRowsOutcome {
  articles: number
  rejected: number
}

type ArticleRow = typeof tables.reportedArticles.$inferInsert

const ARTICLE_COLUMNS = 10

/**
 * Keep the rows of one GKG file whose headline is a lab figure. A row with no
 * web URL, or whose headline doesn't match, is counted as rejected.
 */
export async function storeFigureRows(
  db: PipelineDb,
  input: { stamp: string; fetched_at: string; rows: readonly FigureRow[] },
  now: Date,
): Promise<FigureRowsOutcome> {
  const articles = new Map<string, ArticleRow>()
  let rejected = 0
  for (const row of input.rows) {
    if (!/^https?:\/\//.test(row.url) || !figureHeadline(row.title)) {
      rejected++
      continue
    }
    const id = articleId(row.url)
    if (articles.has(id)) continue
    articles.set(id, {
      id,
      title_key: titleKey(row.title),
      title: row.title,
      outlet: row.outlet,
      url: row.url,
      published_at: stampIso(input.stamp),
      found_at: now.toISOString(),
      record_id: row.record_id,
      source_url: gkgUrl(input.stamp),
      fetched_at: input.fetched_at,
    })
  }
  for (const part of chunk(
    [...articles.values()],
    Math.floor(D1_MAX_BOUND_PARAMS / ARTICLE_COLUMNS),
  )) {
    await db.insert(tables.reportedArticles).values(part).onConflictDoNothing()
  }
  return { articles: articles.size, rejected }
}

/** Files read before figures were looked for, oldest first. */
export async function figureBackfill(
  db: PipelineDb,
  limit: number = FIGURE_FILES_PER_CALL,
): Promise<{ stamp: string; url: string }[]> {
  const rows = await db
    .select({ stamp: tables.gdeltFiles.stamp })
    .from(tables.gdeltFiles)
    .where(and(eq(tables.gdeltFiles.status, 'ok'), isNull(tables.gdeltFiles.figures_at)))
    .orderBy(asc(tables.gdeltFiles.stamp))
    .limit(limit)
  return rows.map(({ stamp }) => ({ stamp, url: gkgUrl(stamp) }))
}

export type FigureFileOutcome =
  | ({ recorded: true } & FigureRowsOutcome)
  | { recorded: false; reason: 'not-pending' }

/** Store the figure headlines of a file read before this side existed, once. */
export async function recordFigureFile(
  db: PipelineDb,
  input: { stamp: string; fetched_at: string; figures: readonly FigureRow[] },
  now: Date,
): Promise<FigureFileOutcome> {
  const [file] = await db
    .select({ status: tables.gdeltFiles.status, figures_at: tables.gdeltFiles.figures_at })
    .from(tables.gdeltFiles)
    .where(eq(tables.gdeltFiles.stamp, input.stamp))
  if (!file || file.status !== 'ok' || file.figures_at !== null) {
    return { recorded: false, reason: 'not-pending' }
  }
  const outcome = await storeFigureRows(
    db,
    { stamp: input.stamp, fetched_at: input.fetched_at, rows: input.figures },
    now,
  )
  await db
    .update(tables.gdeltFiles)
    .set({ figures_at: now.toISOString() })
    .where(eq(tables.gdeltFiles.stamp, input.stamp))
  return { recorded: true, ...outcome }
}
