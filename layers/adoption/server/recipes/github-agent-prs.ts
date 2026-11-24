// Public PRs a lab's coding agent opened on GitHub, per UTC day, via the search API. Each
// agent leaves a different trace, so each is its own trend, never a share: Claude Code's PR
// footer is on by default and can be turned off; Jules opens PRs as its own app; Codex is
// only a `codex/` branch-name convention. Public repositories only. The search API needs a
// token from a Worker (the anonymous limit is per IP), so a deploy without
// NUXT_GITHUB_TOKEN records these as not configured (docs/source-audit.md).
//
// A search answers for any past day, so each run also asks for a few days it has no count
// for, newest first, down to the agent's public launch: first any day a failed run left
// out, then the days before the oldest stored. Those counts are taken now, from the PRs
// that still exist, and the runner labels them retrospective.

import type { CompanyId } from '#layers/core/shared/utils/companies'
import type { Observation, Recipe } from '#layers/core/server/recipes/contract'

const DAY_MS = 86_400_000
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`)
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const dayBefore = (date: string) => isoDay(dayMs(date) - DAY_MS)
const dayAfter = (date: string) => isoDay(dayMs(date) + DAY_MS)

/**
 * Past days fetched per agent per survey tick. Three agents at 1 + 6 searches
 * is 21 a tick, which the fetcher spaces to stay under the authenticated
 * search limit of 30 a minute (GITHUB_SEARCH_MIN_INTERVAL_MS); at four ticks a
 * day, Claude Code's 20 months take under four weeks.
 */
export const BACKFILL_DAYS_PER_RUN = 6

/**
 * Up to `n` days with no stored count, newest first, from `through` back to
 * `floor`. A day a run failed on stays missing, so it is asked for again
 * rather than walked past.
 */
export function missingDays(
  stored: ReadonlySet<string>,
  through: string,
  floor: string,
  n: number,
): string[] {
  const days: string[] = []
  for (let day = through; days.length < n && day >= floor; day = dayBefore(day))
    if (!stored.has(day)) days.push(day)
  return days
}

export function extractSearchCount(body: string, key: string, date: string): Observation[] {
  const doc = JSON.parse(body) as { total_count?: unknown; incomplete_results?: unknown }
  if (typeof doc.total_count !== 'number') throw new Error('not a GitHub search answer')
  // A search that timed out returns a partial count; storing it would be a guess.
  if (doc.incomplete_results !== false) throw new Error('search returned incomplete results')
  return [{ key, date, value: doc.total_count, payload: {} }]
}

const searchUrl = (query: string, day: string) =>
  `https://api.github.com/search/issues?q=${encodeURIComponent(`is:pr ${query} created:${day}`)}&per_page=1`

/** `launched`: the agent's public launch, the first day worth counting. */
export function githubPrRecipe(
  id: string,
  company: CompanyId,
  agent: string,
  query: string,
  launched: string,
): Recipe {
  return {
    id,
    company,
    description: `Public GitHub pull requests per day from ${agent} (search: ${query})`,
    url: ({ now }) => searchUrl(query, dayBefore(now.toISOString().slice(0, 10))),
    ext: 'json',
    // The run's date is the day after the one counted.
    extract: (body, ctx) => extractSearchCount(body, agent, dayBefore(ctx.date)),
    // From yesterday: a live body identical to the last one (a day with no
    // PRs) is stored as unchanged, without its day.
    backfill: ({ stored, now }) => {
      const yesterday = dayBefore(now.toISOString().slice(0, 10))
      return missingDays(stored, yesterday, launched, BACKFILL_DAYS_PER_RUN).map((day) => ({
        url: searchUrl(query, day),
        date: dayAfter(day),
        // Read the day after, as the live run reads it.
        ...(day === yesterday ? { retrospective: false } : {}),
      }))
    },
  }
}

// Launch dates, read 2026-11-20: Claude Code's research preview with Claude
// 3.7 Sonnet (anthropic.com/news/claude-3-7-sonnet), Codex in ChatGPT
// (openai.com/index/introducing-codex), Jules's public beta
// (blog.google/technology/google-labs/jules). Before Codex's launch a
// `codex/` branch is someone else's, so its floor matters most.
export const GITHUB_AGENT_RECIPES: readonly Recipe[] = [
  githubPrRecipe(
    'github-prs-claude-code',
    'anthropic',
    'Claude Code',
    '"Generated with Claude Code"',
    '2025-02-24',
  ),
  githubPrRecipe('github-prs-codex', 'openai', 'Codex', 'head:codex/', '2025-05-16'),
  githubPrRecipe(
    'github-prs-jules',
    'google',
    'Jules',
    'author:app/google-labs-jules',
    '2025-05-20',
  ),
]
