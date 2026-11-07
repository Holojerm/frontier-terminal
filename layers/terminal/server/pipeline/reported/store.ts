// Storing figure headlines from the GDELT GKG files. Two ways in: a file read
// for the first time (recordGkgFile in ../track-record/search.ts passes its
// figure rows here), and a file the track record read before this side
// existed, read again for figures only (recordFigureFile). Either way the
// Worker parses each posted row and matches it again with figureHeadline, so
// the job can't choose what is kept.

import { and, asc, eq, isNull } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { contentHash } from '../contracts'
import type { RawStore } from '../refresh'
import { D1_MAX_BOUND_PARAMS, chunk, type PipelineDb } from '../store'
import { titleKey } from '../track-record/gdelt'
import { gkgUrl, parseGkgRow, stampIso } from '../track-record/gkg'
import { figureHeadline } from './figures'

/** Figure rows one file may post. A file holds a handful; this bounds a runaway match. */
export const MAX_FIGURES_PER_FILE = 200

/** Files handed out per backfill call: about two minutes of the job's reading. */
export const FIGURE_FILES_PER_CALL = 24

export const articleId = (url: string) => contentHash({ url })

export interface FigureRowsOutcome {
  articles: number
  rejected: number
}

type ArticleRow = typeof tables.reportedArticles.$inferInsert

const ARTICLE_COLUMNS = 10

/**
 * Keep the posted rows of one GKG file that are figure headlines read in that
 * quarter hour, with the rows themselves in R2. Rows that don't parse, sit in
 * another quarter hour, or don't match are counted as rejected.
 */
export async function storeFigureRows(
  db: PipelineDb,
  raw: RawStore,
  input: { stamp: string; fetched_at: string; rows: readonly string[] },
  now: Date,
): Promise<FigureRowsOutcome> {
  const seen_at = stampIso(input.stamp)
  const kept: string[] = []
  const articles = new Map<string, ArticleRow>()
  let rejected = 0
  for (const row of input.rows) {
    const article = parseGkgRow(row)
    if (!article || article.seen_at !== seen_at || !figureHeadline(article.title)) {
      rejected++
      continue
    }
    const id = articleId(article.url)
    if (articles.has(id)) continue
    if (!kept.includes(row)) kept.push(row)
    articles.set(id, {
      id,
      title_key: titleKey(article.title),
      title: article.title,
      outlet: article.outlet,
      url: article.url,
      published_at: article.seen_at,
      found_at: now.toISOString(),
      raw_key: null,
      source_url: gkgUrl(input.stamp),
      fetched_at: input.fetched_at,
    })
  }
  if (articles.size === 0) return { articles: 0, rejected }
  const raw_key = `reported/gkg/${input.stamp}.tsv`
  await raw.put(raw_key, `${kept.join('\n')}\n`, 'text/tab-separated-values')
  const rows = [...articles.values()].map((a) => ({ ...a, raw_key }))
  for (const part of chunk(rows, Math.floor(D1_MAX_BOUND_PARAMS / ARTICLE_COLUMNS))) {
    await db.insert(tables.reportedArticles).values(part).onConflictDoNothing()
  }
  return { articles: articles.size, rejected }
}

/** Files the track record read before figures were looked for, oldest first. */
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

/** Store the figure rows of a file already read for the track record, once. */
export async function recordFigureFile(
  db: PipelineDb,
  raw: RawStore,
  input: { stamp: string; fetched_at: string; figures: readonly string[] },
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
    raw,
    { stamp: input.stamp, fetched_at: input.fetched_at, rows: input.figures },
    now,
  )
  await db
    .update(tables.gdeltFiles)
    .set({ figures_at: now.toISOString() })
    .where(eq(tables.gdeltFiles.stamp, input.stamp))
  return { recorded: true, ...outcome }
}
