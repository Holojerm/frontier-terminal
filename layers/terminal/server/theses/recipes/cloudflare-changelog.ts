// Cloudflare's developer changelog (RSS), kept to the AI platform's
// products. Each entry is one observation the judge rates once, so the
// payload carries what a rating may cite: title, products, link, and the
// opening of the entry's text.

import type { Observation, Recipe } from './contract'

export const AI_PRODUCTS = ['Workers AI', 'Agents'] as const

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
}
const unescape = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e]!)
const tag = (item: string, name: string) =>
  item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1] ?? null

export function extractChangelog(body: string): Observation[] {
  if (!body.includes('<rss')) throw new Error('not an RSS feed')
  const out: Observation[] = []
  for (const [item] of body.matchAll(/<item>[\s\S]*?<\/item>/g)) {
    const products = [...item.matchAll(/<category>([^<]*)<\/category>/g)].map((m) =>
      unescape(m[1]!),
    )
    if (!products.some((p) => (AI_PRODUCTS as readonly string[]).includes(p))) continue
    const guid = tag(item, 'guid')
    const title = tag(item, 'title')
    const published = tag(item, 'pubDate')
    if (!guid || !title || !published)
      throw new Error('changelog item missing guid, title or pubDate')
    const summary = unescape(unescape(tag(item, 'description') ?? ''))
      .replace(/<[^>]*>|<[^>]*$/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400)
    out.push({
      key: guid,
      date: new Date(published).toISOString().slice(0, 10),
      value: null,
      payload: {
        title: unescape(title),
        products,
        link: unescape(tag(item, 'link') ?? guid),
        summary,
      },
    })
  }
  if (out.length === 0) throw new Error('no AI platform entries in the changelog')
  return out
}

export const CLOUDFLARE_CHANGELOG: Recipe = {
  id: 'cloudflare-changelog-ai',
  company: 'cloudflare',
  description: `Cloudflare changelog entries for ${AI_PRODUCTS.join(' and ')}`,
  url: () => 'https://developers.cloudflare.com/changelog/rss/index.xml',
  ext: 'xml',
  extract: extractChangelog,
}
