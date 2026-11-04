// The public corrections log on /about#corrections. Add an entry in the same
// PR whenever a fix changes or restores a number the site already published:
// a wrong value, a feed that went stale, a label that misled. History is never
// rewritten; the entry says what readers saw and for how long.

export interface Correction {
  /** The day the fix shipped. */
  on: string
  area: string
  what: string
  fix: string
}

const PR = 'https://github.com/Holojerm/frontier-terminal/pull/'

export const CORRECTIONS: readonly Correction[] = [
  {
    on: '2026-11-04',
    area: 'Demand share',
    what: 'Two different token shares were printed without their denominators: the readout’s share of all OpenRouter tokens and the spend table’s share of the tracked labs’ tokens, side by side on /rankings.',
    fix: `${PR}133`,
  },
  {
    on: '2026-11-04',
    area: 'Theses',
    what: 'The Anthropic thesis passed its horizon (Anthropic’s public S-1, filed 2026-10-26) without the journal recording it. The horizon is now recorded, extended, and the revenue claim it promised is open.',
    fix: `${PR}132`,
  },
  {
    on: '2026-11-03',
    area: 'Prices',
    what: 'Google’s pricing and model pages moved to AI Studio on 2026-11-02; Google prices were not refreshed from 17:05 UTC that day until the fix. Values shown were the last ones read, not wrong ones.',
    fix: `${PR}117`,
  },
  {
    on: '2026-11-01',
    area: 'Prices',
    what: 'OpenAI redesigned its pricing page on 2026-10-23 and every poll failed until the fix; OpenAI prices were not refreshed for nine days.',
    fix: `${PR}84`,
  },
  {
    on: '2026-10-12',
    area: 'Prices',
    what: 'Anthropic’s balanced class showed claude-sonnet-5 after the 5.5 generation launched; it is claude-sonnet-5-5.',
    fix: `${PR}82`,
  },
  {
    on: '2026-10-08',
    area: 'Prices and disclosures',
    what: 'Claude Haiku 5.5’s “From” prices were not parsed, and OpenAI’s redesigned misalignment index (2026-10-07) was not read, until the fix.',
    fix: `${PR}67`,
  },
]
