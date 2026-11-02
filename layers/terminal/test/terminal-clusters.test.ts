import { describe, expect, it } from 'vitest'

import judgePrompt from '../server/pipeline/judge/judge-explain.prompt.md?raw'
import {
  clusterSeries,
  inCluster,
  parseDepartmentClusters,
} from '../server/utils/terminal-clusters'
import { fixtureText } from './pipeline/fixtures'

// The buildout cluster is named once, in sources.yaml, and read by two
// consumers that never see each other: the query layer (this module) and
// the judge prompt (a static markdown file). These tests pin that the
// reader recovers the block, that matching is whole-word and honours the
// exclusion, and that the prompt names the same terms.

const yaml = fixtureText('sources.yaml')
const clusters = parseDepartmentClusters(yaml)
const infra = clusters.find((c) => c.id === 'physical-infrastructure')!

describe('parseDepartmentClusters', () => {
  it('reads the physical-infrastructure cluster with its label, terms and exclusion', () => {
    expect(clusters.map((c) => c.id)).toEqual(['physical-infrastructure'])
    expect(infra.label).toBe('Physical infrastructure')
    expect(infra.terms).toEqual([
      'Data Center',
      'Infrastructure',
      'Facilities',
      'Energy',
      'Construction',
      'Compute',
      'Hardware',
    ])
    expect(infra.exclude).toEqual(['Software'])
  })

  it('fails loudly on a file without the block or a cluster without terms', () => {
    expect(() => parseDepartmentClusters('sources:\n  a:\n    verdict: include\n')).toThrow(
      'no department_clusters block',
    )
    expect(() =>
      parseDepartmentClusters('department_clusters:\n  empty:\n    label: Empty\n'),
    ).toThrow('empty: no terms')
    expect(() =>
      parseDepartmentClusters('department_clusters:\n  x:\n    terms: A\n  - stray list item\n'),
    ).toThrow('line 4')
  })
})

describe('inCluster', () => {
  it.each([
    ['Data Center', true],
    ['Infrastructure', true],
    ['Compute', true],
    ['Hardware', true],
    ['Software Engineering - Infrastructure', false], // the exclusion
    ['Security', false],
    ['Human Data', false], // "Data" alone is not "Data Center"
    ['Energy Storage', true],
    ['Construction Management', true],
    ['Datacenter', false], // not the printed label; whole-word on purpose
  ])('%s → %s', (department, expected) => {
    expect(inCluster(department, infra)).toBe(expected)
  })
})

describe('clusterSeries', () => {
  const dates = ['2026-09-01', '2026-09-02', '2026-09-03']
  const departments = [
    { department: 'Data Center', series: [10, 11, 12] },
    { department: 'Infrastructure', series: [3, 3, 2] },
    { department: 'Software Engineering - Infrastructure', series: [5, 5, 5] },
    { department: 'Model', series: [8, 8, 8] },
  ]

  it('sums the matched departments per day and lists exactly what was summed', () => {
    const out = clusterSeries(infra, departments, dates, 0)
    expect(out).toMatchObject({
      id: 'physical-infrastructure',
      label: 'Physical infrastructure',
      series: [13, 14, 14],
      now: 14,
      then: 13,
      then_at: '2026-09-01',
    })
    expect(out.departments).toEqual([
      { department: 'Data Center', then: 10, now: 12 },
      { department: 'Infrastructure', then: 3, now: 2 },
    ])
  })

  it('reports no comparison before there are two points', () => {
    const out = clusterSeries(infra, departments, dates.slice(0, 1), null)
    expect(out).toMatchObject({ series: [13], now: 13, then: null, then_at: null })
  })
})

describe('the judge prompt names the same cluster', () => {
  it('every term and the exclusion appear in the capacity-signal rule', () => {
    const rule = judgePrompt.match(/\*\*A physical-infrastructure move[\s\S]*?\n- \*\*/)?.[0] ?? ''
    expect(rule).not.toBe('')
    for (const term of infra.terms) expect(rule).toContain(term)
    for (const term of infra.exclude) expect(rule).toContain(`not ${term}`)
  })
})
