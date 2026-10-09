import { describe, expect, it } from 'vitest'

import changelog from '../fixtures/recipes/cloudflare-changelog.xml?raw'
import departments from '../fixtures/recipes/greenhouse-cloudflare-departments.json?raw'
import npm from '../fixtures/recipes/npm-wrangler.json?raw'
import akam from '../fixtures/recipes/sec-companyfacts-akam.json?raw'
import fsly from '../fixtures/recipes/sec-companyfacts-fsly.json?raw'
import net from '../fixtures/recipes/sec-companyfacts-net.json?raw'
import { CLOUDFLARE_THESIS } from '../server/theses/cloudflare'
import { extractChangelog } from '../server/theses/recipes/cloudflare-changelog'
import { extractDepartments } from '../server/theses/recipes/greenhouse-departments'
import { NPM_WRANGLER, extractDownloads } from '../server/theses/recipes/npm-downloads'
import { RECIPES } from '../server/theses/recipes/registry'
import { extractQuarterlyRevenue } from '../server/theses/recipes/sec-revenue'
import { yoyGrowth } from '../server/theses/recipe-signals'

// The Cloudflare thesis's recipes against fixtures captured 2026-10-09
// (fixtures/recipes/, trimmed to the fields each extractor reads). The
// golden values are the filers' own numbers.

const quarter = (obs: ReturnType<typeof extractQuarterlyRevenue>, date: string) =>
  obs.find((o) => o.date === date)?.value

describe('SEC quarterly revenue', () => {
  it('reads Cloudflare’s reported quarters', () => {
    const obs = extractQuarterlyRevenue(net)
    expect(Math.floor(quarter(obs, '2026-06-30')! / 1e6)).toBe(696)
    expect(Math.floor(quarter(obs, '2025-06-30')! / 1e6)).toBe(512)
  })

  it('derives Q4 from the 10-K year less its three quarters, and marks it derived', () => {
    const q4 = extractQuarterlyRevenue(net).filter((o) => o.payload.derived)
    expect(q4.length).toBeGreaterThan(0)
    for (const o of q4) expect(o.date.slice(5)).toBe('12-31')
  })

  it('gives every filer a continuous quarterly series to grow year over year', () => {
    for (const body of [net, akam, fsly]) {
      const growth = yoyGrowth(
        extractQuarterlyRevenue(body).map((o) => ({
          date: o.date,
          value: o.value!,
          source_url: 'u',
          fetched_at: 'f',
        })),
      )
      expect(growth.at(-1)!.date).toBe('2026-06-30')
      expect(Math.abs(growth.at(-1)!.value)).toBeLessThan(1)
    }
  })

  it('throws on a payload with no revenue tag', () => {
    expect(() => extractQuarterlyRevenue('{"facts":{"us-gaap":{}}}')).toThrow('no revenue tag')
  })
})

describe('npm downloads', () => {
  it('reads one observation per day', () => {
    const obs = extractDownloads(npm)
    expect(obs[0]).toMatchObject({ key: 'wrangler', date: '2026-08-01' })
    expect(obs.at(-1)!.date).toBe('2026-10-07')
    expect(obs.every((o) => typeof o.value === 'number')).toBe(true)
  })

  it('reads 540 days on the first run, then the last week up to yesterday', () => {
    const now = new Date('2026-10-09T06:00:00Z')
    expect(NPM_WRANGLER.url({ now, newest: null })).toBe(
      'https://api.npmjs.org/downloads/range/2025-04-17:2026-10-08/wrangler',
    )
    expect(NPM_WRANGLER.url({ now, newest: '2026-10-07' })).toBe(
      'https://api.npmjs.org/downloads/range/2026-09-30:2026-10-08/wrangler',
    )
  })
})

describe('Greenhouse departments', () => {
  it('counts open roles per department on the run date', () => {
    const obs = extractDepartments(departments, { date: '2026-10-09' })
    const by = Object.fromEntries(obs.map((o) => [o.key, o.value]))
    expect(by['Engineering']).toBe(58)
    expect(by['Field Sales']).toBe(57)
    expect(obs.every((o) => o.date === '2026-10-09')).toBe(true)
  })

  it('names only departments the board lists, so the claim’s keys stay real', () => {
    const names = new Set(extractDepartments(departments, { date: '2026-10-09' }).map((o) => o.key))
    const claim = CLOUDFLARE_THESIS.claims.find((c) => c.id === 'cloudflare-hiring-scale')!
    if (claim.spec.kind !== 'measured' || claim.spec.signal !== 'recipe-sum-of-keys')
      throw new Error('spec')
    for (const key of claim.spec.keys) expect(names.has(key), key).toBe(true)
  })
})

describe('Cloudflare changelog', () => {
  it('keeps only Workers AI and Agents entries, with what a rating may cite', () => {
    const obs = extractChangelog(changelog)
    expect(obs).toHaveLength(15)
    for (const o of obs) {
      expect(
        (o.payload.products as string[]).some((p) => p === 'Workers AI' || p === 'Agents'),
      ).toBe(true)
      expect(o.payload.title).toBeTruthy()
      expect(o.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(String(o.payload.summary)).not.toMatch(/<|&lt;/)
    }
  })

  it('throws on something that is not RSS', () => {
    expect(() => extractChangelog('<html></html>')).toThrow('not an RSS feed')
  })
})

describe('the Cloudflare thesis', () => {
  it('reads only recipes that exist', () => {
    const ids = new Set(RECIPES.map((r) => r.id))
    for (const c of CLOUDFLARE_THESIS.claims) {
      const spec = c.spec
      const recipes =
        spec.kind === 'judged'
          ? spec.review === 'recipe-items'
            ? [spec.recipe]
            : []
          : 'recipe' in spec
            ? [spec.recipe, ...('compare_recipes' in spec ? spec.compare_recipes : [])]
            : []
      for (const r of recipes) expect(ids.has(r), `${c.id} → ${r}`).toBe(true)
    }
  })
})
