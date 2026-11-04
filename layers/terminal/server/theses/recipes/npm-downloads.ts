// Daily downloads of an npm package, from the registry's public downloads
// API. The first run reads the 540 days the API allows; later runs re-read
// the last week, since the newest days are revised. Downloads count CI and
// coding agents as much as people, so read the trend, not the level. npm's
// terms allow replicating registry data "using the Public APIs"
// (docs/source-audit.md, 2026-11-04).

import type { CompanyId } from '../../../shared/utils/companies'
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

export function npmRecipe(id: string, company: CompanyId, pkg: string, what: string): Recipe {
  return {
    id,
    company,
    description: `Daily npm downloads of ${pkg}, ${what}`,
    url: ({ now, newest }) => {
      const end = day(now.getTime() - DAY_MS)
      const start = newest
        ? day(Date.parse(newest) - 7 * DAY_MS)
        : day(now.getTime() - 540 * DAY_MS)
      return `https://api.npmjs.org/downloads/range/${start}:${end}/${pkg}`
    },
    ext: 'json',
    extract: extractDownloads,
  }
}

export const NPM_WRANGLER = npmRecipe(
  'npm-wrangler',
  'cloudflare',
  'wrangler',
  'the Cloudflare Workers CLI',
)

/** The labs' official SDKs and coding agents. xAI publishes no npm package. */
export const NPM_LAB_RECIPES: readonly Recipe[] = [
  npmRecipe('npm-openai', 'openai', 'openai', 'the OpenAI SDK'),
  npmRecipe('npm-anthropic-sdk', 'anthropic', '@anthropic-ai/sdk', 'the Anthropic SDK'),
  npmRecipe('npm-google-genai', 'google', '@google/genai', 'the Gemini SDK'),
  npmRecipe('npm-mistral', 'mistral', '@mistralai/mistralai', 'the Mistral SDK'),
  npmRecipe('npm-claude-code', 'anthropic', '@anthropic-ai/claude-code', 'Claude Code'),
  npmRecipe('npm-codex', 'openai', '@openai/codex', 'the Codex CLI'),
  npmRecipe('npm-gemini-cli', 'google', '@google/gemini-cli', 'the Gemini CLI'),
  npmRecipe(
    'npm-claude-agent-sdk',
    'anthropic',
    '@anthropic-ai/claude-agent-sdk',
    'the Claude Agent SDK',
  ),
  npmRecipe('npm-openai-agents', 'openai', '@openai/agents', 'the OpenAI Agents SDK'),
]
