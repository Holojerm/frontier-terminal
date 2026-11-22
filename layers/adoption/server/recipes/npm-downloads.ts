// Daily downloads of an npm package from the registry's public downloads API. Every run
// re-reads the whole window one request answers (540 days to yesterday): npm fills in
// outage days weeks later, and a shorter re-read kept them as zeros for good. Downloads
// count CI and coding agents as much as people, so read the trend, not the level. npm's
// terms allow replicating registry data "using the Public APIs" (docs/source-audit.md).
//
// Older days are walked back one window a run to the package's first day
// (npmBackfill, NPM_FIRST_DAY), since the API answers any range since 2015 and only clips its length.

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
 * The run's range: 540 days back, or from a week before the newest stored
 * day when that is older (a gap after a long outage).
 */
export function npmRange(now: Date, newest: string | null) {
  const yesterday = now.getTime() - DAY_MS
  const window = now.getTime() - RANGE_DAYS * DAY_MS
  const start = newest ? Math.min(Date.parse(newest) - 7 * DAY_MS, window) : window
  const end = Math.min(yesterday, start + RANGE_DAYS * DAY_MS)
  return { start: day(start), end: day(end) }
}

/**
 * The window before the oldest stored day, back to `floor`: one a run, so the
 * deepest package takes four runs. Nothing once the floor is stored.
 */
export function npmBackfill(oldest: string | null, floor: string) {
  if (!oldest || oldest <= floor) return null
  const end = Date.parse(oldest) - DAY_MS
  const start = Math.max(Date.parse(floor), end - (RANGE_DAYS - 1) * DAY_MS)
  return { start: day(start), end: day(end) }
}

/**
 * Where npm history starts. The openai package dates from 2020-07-09, but
 * through 2021 it had days with no downloads at all, which the outage rule
 * above would flag. From 2022 its only zero is npm's outage of 2022-07-22.
 * The controls and wrangler are read back to here, so every lab day has a
 * control day.
 */
export const NPM_HISTORY_FROM = '2022-01-01'

/**
 * The first day read of each lab package: its first release
 * (registry.npmjs.org › time.created, read 2026-11-22), or NPM_HISTORY_FROM
 * for openai. Where its walk back stops, and where its series starts on
 * /signals.
 */
export const NPM_FIRST_DAY = {
  'npm-openai': NPM_HISTORY_FROM,
  'npm-anthropic-sdk': '2023-01-31',
  'npm-google-genai': '2025-03-11',
  'npm-mistral': '2023-12-07',
  'npm-claude-code': '2025-02-24',
  'npm-codex': '2025-04-16',
  'npm-gemini-cli': '2025-06-25',
  'npm-claude-agent-sdk': '2025-09-27',
  'npm-openai-agents': '2025-06-03',
} as const

type LabPackage = keyof typeof NPM_FIRST_DAY

function npmRecipe(
  id: string,
  company: CompanyId,
  pkg: string,
  what: string,
  floor: string = NPM_HISTORY_FROM,
): Recipe {
  const range = (r: { start: string; end: string }) =>
    `https://api.npmjs.org/downloads/range/${r.start}:${r.end}/${pkg}`
  return {
    id,
    company,
    description: `Daily npm downloads of ${pkg}, ${what}`,
    url: ({ now, newest }) => range(npmRange(now, newest)),
    ext: 'json',
    extract: extractDownloads,
    // 1: outage days flagged in the payload.
    revision: 1,
    backfill: ({ oldest }) => {
      const past = npmBackfill(oldest, floor)
      // npm's own count for the day, the figure a read that day would have stored.
      return past ? [{ url: range(past), date: past.end, retrospective: false }] : []
    },
  }
}

const labRecipe = (id: LabPackage, company: CompanyId, pkg: string, what: string) =>
  npmRecipe(id, company, pkg, what, NPM_FIRST_DAY[id])

export const NPM_WRANGLER = npmRecipe(
  'npm-wrangler',
  'cloudflare',
  'wrangler',
  'the Cloudflare Workers CLI',
)

/** The labs' official SDKs and coding agents. xAI publishes no npm package. */
export const NPM_LAB_RECIPES: readonly Recipe[] = [
  labRecipe('npm-openai', 'openai', 'openai', 'the OpenAI SDK'),
  labRecipe('npm-anthropic-sdk', 'anthropic', '@anthropic-ai/sdk', 'the Anthropic SDK'),
  labRecipe('npm-google-genai', 'google', '@google/genai', 'the Gemini SDK'),
  labRecipe('npm-mistral', 'mistral', '@mistralai/mistralai', 'the Mistral SDK'),
  labRecipe('npm-claude-code', 'anthropic', '@anthropic-ai/claude-code', 'Claude Code'),
  labRecipe('npm-codex', 'openai', '@openai/codex', 'the Codex CLI'),
  labRecipe('npm-gemini-cli', 'google', '@google/gemini-cli', 'the Gemini CLI'),
  labRecipe(
    'npm-claude-agent-sdk',
    'anthropic',
    '@anthropic-ai/claude-agent-sdk',
    'the Claude Agent SDK',
  ),
  labRecipe('npm-openai-agents', 'openai', '@openai/agents', 'the OpenAI Agents SDK'),
]

/**
 * The control basket: heavily used packages no AI lab or tracked company
 * publishes a signal through, and that no lab SDK depends on (so a lab's
 * installs don't pull them in). The lab series are divided by its median
 * (layers/adoption/server/recipes/download-series.ts). Not wrangler:
 * Cloudflare is a tracked company and wrangler is its thesis's signal.
 * Read back to NPM_HISTORY_FROM, so every lab day has a control day.
 */
const control = (id: string, pkg: string) => npmRecipe(id, 'frontier-labs', pkg, 'a control')

export const NPM_CONTROL_RECIPES: readonly Recipe[] = [
  control('npm-control-react', 'react'),
  control('npm-control-typescript', 'typescript'),
  control('npm-control-express', 'express'),
  control('npm-control-lodash', 'lodash'),
  control('npm-control-axios', 'axios'),
]
