import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import githubCount from '~~/fixtures/recipes/github-prs-copilot.json?raw'
import { runRecipes } from '#layers/core/server/recipes/run'
import {
  BACKFILL_DAYS_PER_RUN,
  GITHUB_AGENT_RECIPES,
  githubPrRecipe,
  missingDays,
} from '../server/recipes/github-agent-prs'

// The coding-agent PR recipes against GitHub's search limits (#699): every
// daily search goes before any backfill, the fetcher spaces the searches and
// says why a 403 came, and a day a run failed on is asked for again.

const NOW = new Date('2026-11-04T06:00:00Z')
const raw = { put: async (key: string, body: string) => void (await env.BLOB.put(key, body)) }
const dayOf = (url: string) => /created:(\d{4}-\d{2}-\d{2})/.exec(decodeURIComponent(url))![1]!
const queryOf = (url: string) => /q=is:pr (.+) created:/.exec(decodeURIComponent(url))![1]!
const count = (n: number): FetchOutcome => {
  const text = JSON.stringify({ total_count: n, incomplete_results: false, items: [] })
  return { ok: true, status: 200, text, bytes: text.length }
}

/** Every day from `from` through `to`, as a stored set. */
function days(from: string, to: string): Set<string> {
  const out = new Set<string>()
  for (let at = Date.parse(from); at <= Date.parse(to); at += 86_400_000)
    out.add(new Date(at).toISOString().slice(0, 10))
  return out
}

describe('missingDays', () => {
  it('walks back from the oldest stored day, newest first, never before launch', () => {
    const stored = days('2026-11-03', '2026-11-03')
    expect(missingDays(stored, '2026-11-03', '2026-10-01', 3)).toEqual([
      '2026-11-02',
      '2026-11-01',
      '2026-10-31',
    ])
    // Across a month end, and stopping on the floor itself.
    expect(missingDays(days('2026-03-02', '2026-03-02'), '2026-03-02', '2026-02-27', 6)).toEqual([
      '2026-03-01',
      '2026-02-28',
      '2026-02-27',
    ])
    expect(missingDays(days('2026-10-01', '2026-10-05'), '2026-10-05', '2026-10-01', 6)).toEqual([])
  })

  it('asks again for a day a run failed on instead of walking past it', () => {
    const stored = days('2026-10-20', '2026-11-03')
    stored.delete('2026-10-28')
    stored.delete('2026-11-01')
    expect(missingDays(stored, '2026-11-03', '2026-01-01', 4)).toEqual([
      '2026-11-01',
      '2026-10-28',
      '2026-10-19',
      '2026-10-18',
    ])
  })
})

describe('github PR backfill', () => {
  const recipe = githubPrRecipe('t', 'openai', 'Test', 'head:codex/', '2026-10-30')

  it('asks for each past day as the run the day after it would have', () => {
    const runs = recipe.backfill!({
      oldest: '2026-11-02',
      stored: days('2026-11-02', '2026-11-03'),
      now: NOW,
    })
    expect(runs.map((r) => [decodeURIComponent(r.url), r.date, r.retrospective])).toEqual([
      [
        'https://api.github.com/search/issues?q=is:pr head:codex/ created:2026-11-01&per_page=1',
        '2026-11-02',
        undefined,
      ],
      [
        'https://api.github.com/search/issues?q=is:pr head:codex/ created:2026-10-31&per_page=1',
        '2026-11-01',
        undefined,
      ],
      [
        'https://api.github.com/search/issues?q=is:pr head:codex/ created:2026-10-30&per_page=1',
        '2026-10-31',
        undefined,
      ],
    ])
    // The run date round-trips to the day its URL searched.
    expect(recipe.extract(githubCount, { date: runs[0]!.date })[0]!.date).toBe('2026-11-01')
  })

  it('reads yesterday first when the live run stored nothing for it, as the live run would', () => {
    const runs = recipe.backfill!({
      oldest: '2026-11-01',
      stored: days('2026-11-01', '2026-11-02'),
      now: NOW,
    })
    expect(runs.map((r) => [dayOf(r.url), r.retrospective])).toEqual([
      ['2026-11-03', false],
      ['2026-10-31', undefined],
      ['2026-10-30', undefined],
    ])
  })

  it('floors each agent at its public launch', () => {
    const floor = (id: string, oldest: string) =>
      GITHUB_AGENT_RECIPES.find((r) => r.id === id)!.backfill!({
        oldest,
        stored: days(oldest, '2026-11-03'),
        now: NOW,
      }).map((r) => r.date)
    // The last run asked for is the day after launch, which counts launch day.
    expect(floor('github-prs-claude-code', '2025-02-26')).toEqual(['2025-02-26', '2025-02-25'])
    expect(floor('github-prs-codex', '2025-05-17')).toEqual(['2025-05-17'])
    expect(floor('github-prs-jules', '2025-05-20')).toEqual([])
  })
})

describe('github PR recipes in one survey tick', () => {
  const recipes = GITHUB_AGENT_RECIPES.map((r) => ({ ...r, id: `${r.id}-tick` }))
  const asked: string[] = []
  let refuse: (url: string) => boolean = () => false
  const search: SourceFetcher = async (source) => {
    asked.push(source.url)
    // A different count each call, so no live body repeats the last one.
    return refuse(source.url)
      ? { ok: false, status: 403, detail: 'HTTP 403' }
      : count(asked.length + 1000 * runs)
  }
  let runs = 0
  const run = (at: Date) => {
    runs++
    return runRecipes(db, { raw, fetcher: search, now: () => at }, recipes)
  }

  it('runs every daily search before any backfill search', async () => {
    // A first tick stores yesterday for each agent; the second walks back.
    await run(NOW)
    asked.length = 0
    const next = new Date('2026-11-05T06:00:00Z')
    await run(next)
    const yesterday = '2026-11-04'
    const dailies = asked.filter((u) => dayOf(u) === yesterday)
    expect(dailies).toHaveLength(3)
    expect(asked.slice(0, 3)).toEqual(dailies)
    expect(asked).toHaveLength(3 + 3 * BACKFILL_DAYS_PER_RUN)
  })

  it('leaves the daily counts whole when a limiter refuses the backfill partway', async () => {
    asked.length = 0
    let calls = 0
    refuse = () => ++calls > 5
    const at = new Date('2026-11-06T06:00:00Z')
    const results = await run(at)
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok'])
    const stored = await db.select().from(schema.recipeObservations)
    for (const r of recipes)
      expect(stored.some((o) => o.recipe_id === r.id && o.date === '2026-11-05')).toBe(true)
    expect(results[0]!.detail).toMatch(/^backfill as of \d{4}-\d{2}-\d{2}: HTTP 403$/)

    // The refused days are the next tick's first asks, not holes.
    const refusedDays = asked.slice(5).map(dayOf)
    refuse = () => false
    asked.length = 0
    await run(new Date('2026-11-07T06:00:00Z'))
    const byQuery = (q: string) => asked.filter((u) => queryOf(u) === q).map(dayOf)
    const claude = byQuery('"Generated with Claude Code"')
    expect(claude.slice(1)).toContain(refusedDays[0])
  })
})

describe('github search fetches', () => {
  const SEARCH: FetchSource = {
    source_id: 'github-prs-jules',
    url: 'https://api.github.com/search/issues?q=is%3Apr&per_page=1',
    ext: 'json',
  }
  const APP = { appUrl: 'https://frontier-terminal.example', secContactEmail: '' }

  it('spaces search calls start to start', async () => {
    let clock = 0
    const sleeps: number[] = []
    const fetcher = createFetcher({
      ...APP,
      githubToken: 'ghp-test',
      fetch: (async () => new Response(githubCount, { status: 200 })) as typeof fetch,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
    })
    for (let i = 0; i < 3; i++) await fetcher(SEARCH)
    expect(sleeps).toEqual([GITHUB_SEARCH_MIN_INTERVAL_MS, GITHUB_SEARCH_MIN_INTERVAL_MS])
    expect(60_000 / GITHUB_SEARCH_MIN_INTERVAL_MS).toBeLessThan(30)
  })

  it('names the limiter headers and GitHub’s message on a 403', async () => {
    const answer = (body: object, headers: Record<string, string>) =>
      createFetcher({
        ...APP,
        githubToken: 'ghp-test',
        fetch: (async () =>
          new Response(JSON.stringify(body), { status: 403, headers })) as typeof fetch,
        sleep: async () => {},
      })(SEARCH)

    // A secondary limit that sends neither Retry-After nor an empty quota is
    // still the limiter, and follows the 429 policy.
    expect(
      await answer(
        { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' },
        { 'x-ratelimit-remaining': '24', 'x-ratelimit-resource': 'search' },
      ),
    ).toEqual({
      ok: false,
      status: 429,
      detail:
        'HTTP 429 (GitHub’s 403 rate limit, x-ratelimit-remaining 24, x-ratelimit-resource search, “You have exceeded a secondary rate limit. Please wait a few minutes.”)',
    })
    expect(
      await answer(
        { message: 'Resource not accessible by personal access token' },
        { 'x-ratelimit-remaining': '29', 'x-ratelimit-resource': 'search' },
      ),
    ).toEqual({
      ok: false,
      status: 403,
      detail:
        'HTTP 403 (x-ratelimit-remaining 29, x-ratelimit-resource search, “Resource not accessible by personal access token”)',
    })
  })
})
