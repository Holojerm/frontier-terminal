import { describe, expect, it } from 'vitest'

import { buildTearSheet } from '../app/utils/tear-sheet'
import type { RecipeInputs } from '../app/utils/tear-sheet-recipes'

const AT = '2026-11-23T18:02:49.613Z'
const cite = (recipe_id: string, label: string, url: string): RecipeCitation => ({
  recipe_id,
  label,
  source_url: url,
  fetched_at: AT,
})

const months = Array.from({ length: 13 }, (_, i) => {
  const d = new Date(Date.UTC(2025, 9 + i, 1))
  return d.toISOString().slice(0, 10)
})
/** A year earlier, the eleven months between blank, then the newest month. */
const ramp = ([then, now]: [number, number]) => [then, ...Array<null>(11).fill(null), now]

const week = (w: string, total: number, partial = false) => ({
  week: w,
  days: partial ? 5 : 7,
  total,
  partial,
  retrospective: false,
})

const download = (over: Partial<AdoptionData['downloads'][number]>) => ({
  recipe_id: 'npm-x',
  lab: 'anthropic' as const,
  registry: 'npm' as const,
  package: 'x',
  kind: 'sdk' as const,
  last_28d: 100,
  prior_28d: null,
  through: '2026-11-23',
  weekly: [],
  normalized_last_28d: null,
  normalized_prior_28d: null,
  normalized: [],
  share_28d: null,
  share: [],
  series: { normalized: null, share: null },
  source: cite('npm-x', 'npm x', 'https://api.npmjs.org/downloads/range/x'),
  ...over,
})

const inputs: RecipeInputs = {
  adoption: {
    ramp: {
      months,
      series: [
        { key: 'overall', label: 'Any AI vendor', lab: null, values: ramp([50, 56.8]) },
        { key: 'anthropic', label: 'Anthropic', lab: 'anthropic', values: ramp([40.2, 44.78]) },
      ],
      release_seen: '2026-11-19',
      data_version: null,
      source: cite('ramp-ai-index', 'Ramp AI Index', 'https://ramp.com/data/ai-index'),
    },
    downloads: [
      download({
        recipe_id: 'pypi-anthropic',
        registry: 'PyPI',
        package: 'anthropic',
        last_28d: 199_679_855,
        prior_28d: 169_970_064,
      }),
      download({ recipe_id: 'npm-sdk', package: '@anthropic-ai/sdk', last_28d: 278_445_713 }),
      download({ recipe_id: 'npm-new', package: 'new-pkg', kind: 'agent', last_28d: null }),
      download({ recipe_id: 'npm-openai', lab: 'openai', package: 'openai' }),
    ],
    agent_prs: [
      {
        recipe_id: 'gh-claude-code',
        lab: 'anthropic',
        agent: 'Claude Code',
        query: '',
        days: [],
        weekly: [week('2026-11-09', 1_600_000), week('2026-11-16', 2_000_000)],
        source: cite('gh-claude-code', 'GitHub search', 'https://api.github.com/search/issues'),
      },
    ],
    caveats: {
      ramp: 'Ramp caveat.',
      downloads: 'Downloads caveat.',
      normalized: 'Normalized caveat.',
      share: 'Share caveat.',
      agent_prs: 'Agent PRs caveat.',
    },
  },
  pay: {
    boards: [
      {
        recipe_id: 'pay-anthropic',
        lab: 'anthropic',
        date: '2026-11-25',
        roles_on_board: 635,
        cells: [
          {
            key: 'all',
            label: 'All roles',
            median: 361_250,
            p25: 290_000,
            p75: 435_000,
            n: 486,
            departments: null,
            previous: { date: '2026-11-18', median: 350_000 },
          },
          {
            key: 'research',
            label: 'Research',
            median: 445_000,
            p25: 400_000,
            p75: 560_000,
            n: 61,
            departments: ['Research'],
            previous: null,
          },
        ],
        source: cite(
          'pay-anthropic',
          'Anthropic job board',
          'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs',
        ),
      },
    ],
    caveat: 'Pay caveat.',
  },
  limits: {
    pages: [
      {
        recipe_id: 'limits-anthropic',
        lab: 'anthropic',
        covers: 'Anthropic, per model and usage tier',
        metrics: ['RPM', 'ITPM'],
        rows: [
          {
            model: 'Claude Opus 5.5',
            tier: 'Start',
            values: { RPM: 50, ITPM: 30_000 },
            text: null,
          },
          { model: 'Claude Opus 5.5', tier: 'Build', values: { RPM: 1000 }, text: null },
        ],
        snapshot: '2026-11-10',
        previous: '2026-11-06',
        changed: 18,
        source: cite(
          'limits-anthropic',
          'Anthropic rate limits',
          'https://docs.claude.com/rate-limits',
        ),
      },
    ],
    caveat: 'Limits caveat.',
  },
  datacenters: {
    snapshot: '2026-11-23',
    labs: [
      {
        lab: 'anthropic',
        mw: 2533,
        h100e: 2_498_726.6,
        sites: 5,
        shared: 1,
        names: ['New Carlisle', 'Colossus 2', 'Colossus 1', 'Lake Mariner'],
      },
      { lab: 'mistral', mw: 0, h100e: 0, sites: 1, shared: 0, names: ['EcoDataCenter 2'] },
    ],
    speculative_only: ['google'],
    source: cite(
      'epoch-data-centers',
      'Epoch AI, AI data centers',
      'https://epoch.ai/data/data_centers/data_centers.csv',
    ),
    caveat: 'Epoch caveat.',
  },
}

describe('tear sheet recipe sections', () => {
  const sheet = buildTearSheet('anthropic', inputs)
  const refOf = (url: string) => sheet.sources.find((s) => s.url === url)!.n

  it('reads the lab’s Ramp share for the newest month, against a year earlier, cited to Ramp', () => {
    expect(sheet.adoption[0]).toEqual({
      label: 'US businesses on Ramp paying it',
      value: '44.8%',
      delta: '+4.6 pp on Oct 2025',
      lines: ['Oct 2026, from Ramp’s release first stored 2026-11-19. Any AI vendor: 56.8%.'],
      gap: null,
      ref: refOf('https://ramp.com/data/ai-index'),
    })
  })

  it('prints a coding agent’s newest whole week against the week before', () => {
    expect(sheet.adoption[1]).toMatchObject({
      label: 'Public PRs by Claude Code, a week',
      value: '2,000,000',
      delta: '+25% on the week before',
      lines: ['Week of 2026-11-16.'],
    })
  })

  it('never compares a week with days missing', () => {
    const partial = structuredClone(inputs)
    partial.adoption!.agent_prs[0]!.weekly[1] = week('2026-11-16', 1_000_000, true)
    const fig = buildTearSheet('anthropic', partial).adoption[1]!
    expect(fig.delta).toBeNull()
    expect(fig.lines).toEqual(['Week of 2026-11-16, 5 of 7 days on record.'])
  })

  it('lists only the lab’s packages, largest first, with the gap for a short record', () => {
    expect(sheet.downloads.rows.map((r) => [r.package, r.registry, r.last, r.change])).toEqual([
      ['@anthropic-ai/sdk', 'npm', '278M', '—'],
      ['anthropic', 'PyPI', '200M', '+17.5%'],
      ['new-pkg', 'npm', null, '—'],
    ])
    expect(sheet.downloads.gap).toBeNull()
  })

  it('prints each pay cell with its band count and its change since the last read', () => {
    expect(sheet.pay.rows.map((r) => [r.label, r.median, r.range, r.bands, r.change])).toEqual([
      ['All roles', '$361K', '$290K–$435K', '486 of 635', '+3.2% since 2026-11-18'],
      ['Research', '$445K', '$400K–$560K', '61', 'First read 2026-11-25'],
    ])
    expect(sheet.pay.rows[0]!.ref).toBe(
      refOf('https://boards-api.greenhouse.io/v1/boards/anthropic/jobs'),
    )
  })

  it('counts the published limits and dates the last change', () => {
    expect(sheet.limits.rows).toEqual([
      {
        key: 'limits-anthropic',
        covers: 'Anthropic, per model and usage tier',
        limits: '3',
        change: '18 changed on 2026-11-10',
        ref: refOf('https://docs.claude.com/rate-limits'),
      },
    ])
  })

  it('states Epoch’s power with its sites, and carries Epoch’s license line', () => {
    expect(sheet.power).toMatchObject({
      value: '2,533 MW',
      lines: [
        '2.50M H100-equivalents across 5 sites, 1 shared with another lab.',
        'Largest: New Carlisle, Colossus 2, Colossus 1. Epoch’s data of 2026-11-23.',
      ],
      gap: null,
    })
    expect(sheet.citations).toContain('Data-center power: CC BY 4.0, Epoch AI.')
  })

  it('prints the caveat of every recipe dataset it shows', () => {
    expect(sheet.caveats.map((c) => c.text)).toEqual([
      'Ramp caveat.',
      'Downloads caveat.',
      'Agent PRs caveat.',
      'Pay caveat.',
      'Epoch caveat.',
      'Limits caveat.',
    ])
  })

  it('numbers each recipe source once in the shared list', () => {
    expect(new Set(sheet.sources.map((s) => s.url)).size).toBe(sheet.sources.length)
    expect(sheet.sources.map((s) => s.n)).toEqual(sheet.sources.map((_, i) => i + 1))
  })
})

describe('monthYear', () => {
  it('names a series month in UTC, and passes a malformed one through', () => {
    expect(monthYear('2026-10-01')).toBe('Oct 2026')
    expect(monthYear('2026-13-01')).toBe('2026-13-01')
  })
})

describe('tear sheet recipe gaps', () => {
  it('states a zero-MW site as no power yet, still citing Epoch', () => {
    const power = buildTearSheet('mistral', inputs).power
    expect(power.value).toBeNull()
    expect(power.gap?.title).toBe('No power yet')
    expect(power.lines).toEqual(['1 site: EcoDataCenter 2. Epoch’s data of 2026-11-23.'])
    expect(power.ref).toBe(1)
  })

  it('names the speculative-only gap and the lab Epoch doesn’t name', () => {
    expect(buildTearSheet('google', inputs).power.gap?.title).toBe('No site counted')
    expect(buildTearSheet('xai', inputs).power.gap?.title).toBe('No site named')
  })

  it('states every recipe gap for a lab no recipe reads, and prints no caveat', () => {
    const sheet = buildTearSheet('deepseek', inputs)
    expect(sheet.adoption).toEqual([
      expect.objectContaining({
        value: null,
        gap: expect.objectContaining({ title: 'Not in Ramp’s vendor series' }),
      }),
    ])
    expect(sheet.downloads.gap?.title).toBe('No package tracked')
    expect(sheet.pay.gap?.title).toBe('No posted pay read')
    expect(sheet.limits.gap?.title).toBe('No published limits read')
    expect(sheet.caveats).toEqual([])
    expect(sheet.citations).toEqual([])
    expect(sheet.sources).toEqual([])
  })

  it('builds with no recipe payload at all', () => {
    const sheet = buildTearSheet('mistral', {})
    expect(sheet.adoption.map((f) => f.gap?.title)).toEqual(['No Ramp release stored yet'])
    expect(sheet.power.gap?.title).toBe('No power data yet')
    expect(sheet.pay.rows).toEqual([])
    expect(sheet.caveats).toEqual([])
  })
})
