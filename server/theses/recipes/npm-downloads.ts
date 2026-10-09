// Daily downloads of an npm package, from the registry's public downloads
// API. The first run reads the 540 days the API allows; later runs re-read
// the last week, since the newest days are revised. Downloads count CI and
// coding agents as much as people, so read the trend, not the level.

import type { Recipe } from './contract'

const DAY_MS = 86_400_000
const day = (t: number) => new Date(t).toISOString().slice(0, 10)

export function extractDownloads(body: string) {
  const doc = JSON.parse(body) as {
    package?: string
    downloads?: { day: string; downloads: number }[]
  }
  if (!doc.package || !Array.isArray(doc.downloads)) throw new Error('not an npm downloads range')
  return doc.downloads.map((d) => ({
    key: doc.package!,
    date: d.day,
    value: d.downloads,
    payload: {},
  }))
}

export const NPM_WRANGLER: Recipe = {
  id: 'npm-wrangler',
  company: 'cloudflare',
  description: 'Daily npm downloads of wrangler, the Cloudflare Workers CLI',
  url: ({ now, newest }) => {
    const end = day(now.getTime() - DAY_MS)
    const start = newest ? day(Date.parse(newest) - 7 * DAY_MS) : day(now.getTime() - 540 * DAY_MS)
    return `https://api.npmjs.org/downloads/range/${start}:${end}/wrangler`
  },
  ext: 'json',
  extract: extractDownloads,
}
