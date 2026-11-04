// Public pull requests a lab's coding agent opened on GitHub, counted per
// UTC day through the search API. Each agent leaves a different trace, so
// each is a trend of its own and never a share against the others:
// Claude Code's PR footer is on by default and users can turn it off; Jules
// opens PRs as its own app; Codex is only a `codex/` branch-name convention.
// Public repositories only. The search API needs a token from a Worker (its
// anonymous limit is per IP), so a deploy without NUXT_GITHUB_TOKEN records
// these as not configured (docs/source-audit.md, 2026-11-04).

import type { CompanyId } from '../../../shared/utils/companies'
import type { Observation, Recipe } from './contract'

const DAY_MS = 86_400_000
const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS)

export function extractSearchCount(body: string, key: string, date: string): Observation[] {
  const doc = JSON.parse(body) as { total_count?: unknown; incomplete_results?: unknown }
  if (typeof doc.total_count !== 'number') throw new Error('not a GitHub search answer')
  // A search that timed out returns a partial count; storing it would be a guess.
  if (doc.incomplete_results !== false) throw new Error('search returned incomplete results')
  return [{ key, date, value: doc.total_count, payload: {} }]
}

export function githubPrRecipe(
  id: string,
  company: CompanyId,
  agent: string,
  query: string,
): Recipe {
  return {
    id,
    company,
    description: `Public GitHub pull requests per day from ${agent} (search: ${query})`,
    url: ({ now }) => {
      const day = dayBefore(now.toISOString().slice(0, 10)).toISOString().slice(0, 10)
      const q = encodeURIComponent(`is:pr ${query} created:${day}`)
      return `https://api.github.com/search/issues?q=${q}&per_page=1`
    },
    ext: 'json',
    // The run's date is the day after the one counted.
    extract: (body, ctx) =>
      extractSearchCount(body, agent, dayBefore(ctx.date).toISOString().slice(0, 10)),
  }
}

export const GITHUB_AGENT_RECIPES: readonly Recipe[] = [
  githubPrRecipe(
    'github-prs-claude-code',
    'anthropic',
    'Claude Code',
    '"Generated with Claude Code"',
  ),
  githubPrRecipe('github-prs-codex', 'openai', 'Codex', 'head:codex/'),
  githubPrRecipe('github-prs-jules', 'google', 'Jules', 'author:app/google-labs-jules'),
]
