// Daily downloads of an npm package, from the registry's public downloads
// API. Every run re-reads the whole window the API answers in one request
// (540 days to yesterday): npm fills in outage days weeks later, and a
// shorter re-read kept them as zeros for good (Sep and Oct 2026). Downloads
// count CI and coding agents as much as people, so read the trend, not the
// level. npm's terms allow replicating registry data "using the Public APIs"
// (docs/source-audit.md, 2026-11-04).

import type { CompanyId } from '#layers/core/shared/utils/companies'
import type { Recipe } from '#layers/core/server/recipes/contract'

const DAY_MS = 86_400_000
/** How far back a range starts; npm clips a longer one at its start without an error. */
const RANGE_DAYS = 540
const day = (t: number) => new Date(t).toISOString().slice(0, 10)

/**
 * A zero after the package's first non-zero day is an npm stats outage: every
 * package reads zero that day (2026-10-14, 10-15, 10-19, 10-20 among them).
 * The zero is kept as npm served it and flagged, so readers can leave it out.
 * Zeros before the first non-zero day are a package not yet published.
 */
export function extractDownloads(body: string) {
  const doc = JSON.parse(body) as {
    package?: string
    downloads?: { day: string; downloads: number }[]
  }
  if (!doc.package || !Array.isArray(doc.downloads)) throw new Error('not an npm downloads range')
  let published = false
  return doc.downloads.map((d) => {
    const outage = published && d.downloads === 0
    if (d.downloads > 0) published = true
    return { key: doc.package!, date: d.day, value: d.downloads, payload: outage ? { outage } : {} }
  })
}

/**
 * The run's range. The first run starts at `from` when given (and reads one
 * range's worth from there, so a deep start takes a run per 540 days), else
 * 540 days back. A later run re-reads the full window, or from a week before
 * the newest stored day when that is older (a gap after a long outage).
 */
export function npmRange(now: Date, newest: string | null, from?: string) {
  const yesterday = now.getTime() - DAY_MS
  const window = now.getTime() - RANGE_DAYS * DAY_MS
  const start = newest
    ? Math.min(Date.parse(newest) - 7 * DAY_MS, window)
    : from
      ? Date.parse(from)
      : window
  const end = Math.min(yesterday, start + RANGE_DAYS * DAY_MS)
  return { start: day(start), end: day(end) }
}

export function npmRecipe(
  id: string,
  company: CompanyId,
  pkg: string,
  what: string,
  from?: string,
): Recipe {
  return {
    id,
    company,
    description: `Daily npm downloads of ${pkg}, ${what}`,
    url: ({ now, newest }) => {
      const { start, end } = npmRange(now, newest, from)
      return `https://api.npmjs.org/downloads/range/${start}:${end}/${pkg}`
    },
    ext: 'json',
    extract: extractDownloads,
    // 1: outage days flagged in the payload.
    revision: 1,
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

/** Where the lab packages' npm history starts (their first read, 2026-11-04, less 540 days). */
export const NPM_HISTORY_FROM = '2025-05-13'

/**
 * The control basket: heavily used packages no AI lab or tracked company
 * publishes a signal through, and that no lab SDK depends on (so a lab's
 * installs don't pull them in). The lab series are divided by its median
 * (layers/adoption/server/recipes/download-series.ts). Not wrangler:
 * Cloudflare is a tracked company and wrangler is its thesis's signal.
 * Read from NPM_HISTORY_FROM, so every lab day has a control day.
 */
export const NPM_CONTROL_RECIPES: readonly Recipe[] = [
  npmRecipe('npm-control-react', 'frontier-labs', 'react', 'a control', NPM_HISTORY_FROM),
  npmRecipe('npm-control-typescript', 'frontier-labs', 'typescript', 'a control', NPM_HISTORY_FROM),
  npmRecipe('npm-control-express', 'frontier-labs', 'express', 'a control', NPM_HISTORY_FROM),
  npmRecipe('npm-control-lodash', 'frontier-labs', 'lodash', 'a control', NPM_HISTORY_FROM),
  npmRecipe('npm-control-axios', 'frontier-labs', 'axios', 'a control', NPM_HISTORY_FROM),
]
