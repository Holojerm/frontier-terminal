// The labs' own newsroom feeds (RSS), for the track record: when a lab
// announced something itself (layers/terminal/server/pipeline/track-record/).
// Each post is one observation, keyed by its guid, with its exact publication
// time in the payload. Anthropic and xAI publish no feed (sources.yaml cut).

import { contentHashOfText } from '../../pipeline/contracts'
import type { Observation, Recipe } from './contract'

/** Posts older than this are not kept: the track record starts 2026-09-08 and looks 7 days back. */
export const NEWSROOM_FROM = '2026-08-01'

/** Characters of a post's description kept for the judge to read. */
export const NEWSROOM_SUMMARY_CHARS = 400

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function unescapeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, e: string) => {
    if (e.startsWith('#x') || e.startsWith('#X'))
      return String.fromCodePoint(parseInt(e.slice(2), 16))
    if (e.startsWith('#')) return String.fromCodePoint(Number(e.slice(1)))
    return NAMED[e.toLowerCase()] ?? whole
  })
}

const cdata = (s: string) => s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')

const tag = (item: string, name: string): string | null => {
  const m = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return m ? cdata(m[1]!) : null
}

const plain = (html: string) =>
  unescapeXml(html.replace(/<[^>]*>/g, ' '))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** One observation per post published on or after NEWSROOM_FROM. */
export function extractNewsroom(body: string): Observation[] {
  if (!body.includes('<rss')) throw new Error('not an RSS feed')
  const out: Observation[] = []
  let items = 0
  for (const [item] of body.matchAll(/<item>[\s\S]*?<\/item>/g)) {
    items++
    const title = tag(item, 'title')
    const link = tag(item, 'link')
    const pubDate = tag(item, 'pubDate')
    if (!title || !link || !pubDate) throw new Error('feed item missing title, link or pubDate')
    const published = new Date(pubDate.trim())
    if (Number.isNaN(published.getTime())) throw new Error(`unreadable pubDate ${pubDate}`)
    const published_at = published.toISOString()
    if (published_at.slice(0, 10) < NEWSROOM_FROM) continue
    const url = unescapeXml(link.trim())
    out.push({
      key: unescapeXml((tag(item, 'guid') ?? url).trim()),
      date: published_at.slice(0, 10),
      value: null,
      payload: {
        title: plain(title),
        link: url,
        published_at,
        summary: plain(tag(item, 'description') ?? '').slice(0, NEWSROOM_SUMMARY_CHARS),
      },
    })
  }
  if (items === 0) throw new Error('no items in the feed')
  return out
}

function newsroom(id: string, company: Recipe['company'], name: string, url: string): Recipe {
  return {
    id,
    company,
    description: `${name}’s newsroom feed: post titles, links and publication times`,
    url: () => url,
    ext: 'xml',
    extract: extractNewsroom,
    // A feed's lastBuildDate moves on every fetch; only its posts are a change.
    fingerprint: (body) => contentHashOfText(JSON.stringify(extractNewsroom(body))),
  }
}

export const NEWSROOM_OPENAI = newsroom(
  'newsroom-openai',
  'openai',
  'OpenAI',
  'https://openai.com/news/rss.xml',
)
export const NEWSROOM_GOOGLE_DEEPMIND = newsroom(
  'newsroom-google-deepmind',
  'google',
  'Google DeepMind',
  'https://deepmind.google/blog/rss.xml',
)
export const NEWSROOM_META = newsroom('newsroom-meta', 'meta', 'Meta', 'https://about.fb.com/feed/')
export const NEWSROOM_MISTRAL = newsroom(
  'newsroom-mistral',
  'mistral',
  'Mistral',
  'https://mistral.ai/news/rss',
)

export const NEWSROOM_RECIPES: readonly Recipe[] = [
  NEWSROOM_OPENAI,
  NEWSROOM_GOOGLE_DEEPMIND,
  NEWSROOM_META,
  NEWSROOM_MISTRAL,
]

/** The newsroom recipe for each lab that has one. */
export const NEWSROOM_OF: Readonly<Record<string, Recipe>> = Object.fromEntries(
  NEWSROOM_RECIPES.map((r) => [r.company, r]),
)
