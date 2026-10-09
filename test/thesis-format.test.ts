import { describe, expect, it } from 'vitest'

import { THESES } from '../server/theses/registry'
import {
  datasetRequestUrl,
  detailRows,
  factRows,
  formatValue,
  journalUrl,
  statusCounts,
  thesisPages,
  valueKind,
} from '../shared/utils/thesis-format'

describe('measured values', () => {
  it('reads the unit off the shape of the detail the signal recorded', () => {
    expect(valueKind({ ratios: { anthropic: 1.87 }, compare: 1.4 })).toBe('ratio')
    expect(valueKind({ shares: { anthropic: 0.264 }, compare: null })).toBe('share')
    expect(valueKind({ by_department: { Sales: 3 }, compare: null })).toBe('count')
    expect(valueKind({ compare: null })).toBe('plain')
    expect(valueKind(null)).toBe('plain')
  })

  it('formats a ratio, a share, and a count', () => {
    expect(formatValue('ratio', 1.87)).toBe('1.87×')
    expect(formatValue('ratio', 0.5)).toBe('0.50×')
    expect(formatValue('share', 0.264)).toBe('26.4%')
    expect(formatValue('share', 0.25)).toBe('25%')
    expect(formatValue('count', 1234.4)).toBe('1,234')
    expect(formatValue('plain', 0.123456)).toBe('0.1235')
  })

  it('names each lab beside the figure it shares a reading with', () => {
    const rows = detailRows({
      window: { from: '2026-10-01', to: '2026-10-07' },
      ratios: { anthropic: 1.87, openai: 1.2 },
      compare: 1.2,
    })
    expect(rows).toEqual([
      { label: 'Window', value: '2026-10-01 to 2026-10-07' },
      { label: 'Each lab', value: 'Anthropic 1.87× · OpenAI 1.20×' },
    ])
    expect(detailRows(undefined)).toEqual([])
  })
})

describe('judged facts', () => {
  it('renders a price cut readably', () => {
    expect(
      factRows({
        model_slug: 'gpt-5',
        input_before: 10,
        input_after: 6,
        output_before: null,
        output_after: null,
        cut_pct: 40,
      }),
    ).toEqual([
      { label: 'Model', value: 'gpt-5' },
      { label: 'Cut', value: '−40%' },
      { label: 'Input per Mtok', value: '$10.00 → $6.00' },
    ])
  })

  it('renders an incident, and says so when it is still open', () => {
    const rows = factRows({
      title: 'Elevated errors on the API',
      impact: 'major',
      started_at: '2026-10-08T01:00:00Z',
      resolved_at: null,
      hours: 3.5,
    })
    expect(rows.map((r) => r.label)).toEqual(['Title', 'Impact', 'Started', 'Resolved', 'Duration'])
    expect(rows.find((r) => r.label === 'Duration')?.value).toBe('3.5 h')
    expect(rows.find((r) => r.label === 'Resolved')?.value).toBe('not yet')
    expect(rows.find((r) => r.label === 'Title')?.value).toBe('Elevated errors on the API')
  })

  it('keeps a fact it has no label for, and drops a null one', () => {
    expect(factRows({ severity_note: 'high', kind: null })).toEqual([
      { label: 'Severity note', value: 'high' },
    ])
  })
})

describe('thesis listing', () => {
  it('counts statuses worst first and omits empty ones', () => {
    const claims = [
      { status: 'holding' },
      { status: 'unresolved' },
      { status: 'holding' },
      { status: 'broken' },
    ] as const
    expect(statusCounts(claims)).toEqual([
      { status: 'broken', n: 1 },
      { status: 'holding', n: 2 },
      { status: 'unresolved', n: 1 },
    ])
  })

  it('lists one page per registered thesis', () => {
    const pages = thesisPages(THESES)
    expect(pages.map((p) => p.path)).toEqual(THESES.map((t) => `/theses/${t.id}`))
    expect(pages[0]?.title).toMatch(/thesis$/)
  })

  it('builds the repo links from the repo URL', () => {
    const repo = 'https://github.com/Holojerm/frontier-terminal'
    expect(journalUrl(repo, 'docs/theses/anthropic.md')).toBe(
      `${repo}/blob/main/docs/theses/anthropic.md`,
    )
    expect(datasetRequestUrl(repo)).toBe(`${repo}/issues/new?template=dataset-request.yml`)
  })
})
