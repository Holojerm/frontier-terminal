// Two labs side by side. Every pair of the tracked labs has one URL, spelled
// in LABS order (openai-vs-anthropic, never anthropic-vs-openai), so a
// comparison has a single canonical address and the reverse spelling
// redirects to it instead of competing with it.

import { LAB_DISPLAY } from './terminal-labs'
import { LABS } from './terminal-lab-summary'
import type { LabId } from './terminal-types'

export type LabPair = readonly [LabId, LabId]

/** Every unordered pair of tracked labs, in LABS order. Grows with LABS, never reorders. */
export const COMPARE_PAIRS: readonly LabPair[] = LABS.flatMap((a, i) =>
  LABS.slice(i + 1).map((b) => [a, b] as const),
)

const SEPARATOR = '-vs-'

export const pairSlug = ([a, b]: LabPair) => `${a}${SEPARATOR}${b}`
export const comparePath = (pair: LabPair) => `/compare/${pairSlug(pair)}`
export const pairTitle = ([a, b]: LabPair) => `${LAB_DISPLAY[a]} vs ${LAB_DISPLAY[b]}`

/**
 * A route slug as the pair it names, with `canonical` false when the labs are
 * spelled in reverse. Null for anything that is not two distinct tracked labs.
 */
export function parsePair(slug: string): { pair: LabPair; canonical: boolean } | null {
  const parts = slug.split(SEPARATOR)
  if (parts.length !== 2) return null
  const [a, b] = parts as [string, string]
  const ia = (LABS as readonly string[]).indexOf(a)
  const ib = (LABS as readonly string[]).indexOf(b)
  if (ia === -1 || ib === -1 || ia === ib) return null
  return ia < ib
    ? { pair: [LABS[ia]!, LABS[ib]!], canonical: true }
    : { pair: [LABS[ib]!, LABS[ia]!], canonical: false }
}

/** The compare pages in the shape `definePageMeta({ publicPage })` produces, like LAB_PAGES. */
export const COMPARE_PAGES = COMPARE_PAIRS.map((pair) => ({
  labs: pair,
  path: comparePath(pair),
  changefreq: 'daily' as const,
  priority: '0.7',
  title: pairTitle(pair),
  summary: `${pairTitle(pair)} side by side: flagship API price, disclosed SEC revenue, OpenRouter demand share, open roles and the infrastructure buildout, and status-page incidents.`,
}))
