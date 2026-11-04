// GDELT DOC 2.0 (api.gdeltproject.org/api/v2/doc/doc), artlist mode: the
// articles GDELT's crawler saw for a query in a time range. Terms and rate:
// sources.yaml › track_record_sources › gdelt-doc.
//
// What an article row carries is what GDELT records: url, title, seendate
// (when GDELT first saw it, UTC), domain, language, sourcecountry. There is
// no snippet and no publication time, and we never fetch the article itself.

import { z } from 'zod'

export const GDELT_DOC_URL = 'https://api.gdeltproject.org/api/v2/doc/doc'

/** GDELT asks for "one every 5 seconds"; the search waits this long between queries. */
export const GDELT_SPACING_MS = 6_000

/** The DOC API searches a rolling three months; older windows are not searched. */
export const GDELT_HORIZON_DAYS = 90

/** Articles kept per alert: the earliest ones, since the first report is the one that counts. */
export const PRESS_CANDIDATE_LIMIT = 20

/** Asked of GDELT: more than kept, so syndicated copies can be dropped first. */
export const GDELT_MAX_RECORDS = 75

/** 2026-10-01T12:30:00.000Z -> 20261001123000, GDELT's UTC datetime format. */
export function gdeltStamp(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\.\d+Z$/, '')
}

export function gdeltUrl(query: string, windowStart: string, windowEnd: string): string {
  const params = new URLSearchParams({
    query,
    mode: 'artlist',
    format: 'json',
    sort: 'dateasc',
    maxrecords: String(GDELT_MAX_RECORDS),
    startdatetime: gdeltStamp(windowStart),
    enddatetime: gdeltStamp(windowEnd),
  })
  return `${GDELT_DOC_URL}?${params.toString()}`
}

const Article = z.object({
  url: z.string().url(),
  title: z.string(),
  seendate: z.string().regex(/^\d{8}T\d{6}Z$/),
  domain: z.string(),
  language: z.string().optional(),
  sourcecountry: z.string().optional(),
})

export interface PressArticle {
  url: string
  title: string
  outlet: string
  /** When GDELT first saw it, ISO UTC. */
  seen_at: string
  language: string | null
}

/** 20261001T123000Z -> 2026-10-01T12:30:00.000Z */
export function seenDateIso(seendate: string): string {
  const m = seendate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (!m) throw new Error(`unreadable seendate ${seendate}`)
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).toISOString()
}

const titleKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * The articles in a DOC API response, earliest first, one per title (a wire
 * story syndicated to fifty sites is one report, first seen at its earliest
 * copy), capped at PRESS_CANDIDATE_LIMIT. An empty result is `{}`; anything
 * that is not JSON (GDELT answers errors in plain text) throws.
 */
export function parseGdeltArticles(body: string): PressArticle[] {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{')) throw new Error(`not JSON: ${trimmed.slice(0, 120)}`)
  const parsed = z
    .object({ articles: z.array(z.unknown()).optional() })
    .parse(JSON.parse(trimmed) as unknown)
  const articles: PressArticle[] = []
  for (const raw of parsed.articles ?? []) {
    const row = Article.safeParse(raw)
    if (!row.success || !row.data.title.trim()) continue
    articles.push({
      url: row.data.url,
      title: row.data.title.trim(),
      outlet: row.data.domain,
      seen_at: seenDateIso(row.data.seendate),
      language: row.data.language ?? null,
    })
  }
  articles.sort((a, b) => a.seen_at.localeCompare(b.seen_at) || a.url.localeCompare(b.url))
  const seen = new Set<string>()
  const out: PressArticle[] = []
  for (const a of articles) {
    const key = titleKey(a.title)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a)
    if (out.length === PRESS_CANDIDATE_LIMIT) break
  }
  return out
}
