import { describe, expect, it } from 'vitest'

import radio2024 from '~~/fixtures/limits/wayback/anthropic-rate-limits-2024-04.html?raw'
import tabs2024 from '~~/fixtures/limits/wayback/anthropic-rate-limits-2024-10.html?raw'
import tabs2025 from '~~/fixtures/limits/wayback/anthropic-rate-limits-2025-07.html?raw'

import { limitChanges } from '../server/pipeline/archive/limit-events'
import { LIMITS_ARCHIVE_ERAS, LIMITS_LIVE_FROM } from '../server/pipeline/archive/limits-eras'
import { limitsRows } from '../server/pipeline/archive/rows'
import {
  parseAnthropicLimitsHtml,
  tierName,
} from '../server/pipeline/parsers/limits/wayback-anthropic-limits'

const value = (rows: { key: string; value: number | null }[], key: string) =>
  rows.find((r) => r.key === key)?.value

describe('Anthropic’s archived rate-limit page', () => {
  it('reads every tier’s table where a labeled radio button names it (2024-04)', () => {
    const { rows, passed } = parseAnthropicLimitsHtml(radio2024)
    expect(passed).toEqual([])
    expect(value(rows, 'spend cap|Tier 1|USD per month')).toBe(100)
    expect(value(rows, 'wait to reach tier|Tier 4|days')).toBe(14)
    expect(value(rows, 'spend cap|Scale|USD per month')).toBeNull()
    expect(value(rows, 'Claude 3 Opus|Free|TPM')).toBe(10_000)
    expect(value(rows, 'Claude 3 Haiku|Tier 2|RPM')).toBe(1_000)
  })

  it('reads the one tab the 2024 tab layout renders as its first tab', () => {
    const { rows } = parseAnthropicLimitsHtml(tabs2024)
    expect(value(rows, 'Claude 3.5 Sonnet|Tier 1|RPM')).toBe(50)
    expect(rows.some((r) => r.tier === 'Tier 2' && r.metric === 'RPM')).toBe(false)
  })

  it('skips rate tables it can’t tie to a tier, and says so (2025-07)', () => {
    const { rows, passed } = parseAnthropicLimitsHtml(tabs2025)
    expect(rows.every((r) => !['RPM', 'ITPM', 'OTPM'].includes(r.metric))).toBe(true)
    expect(passed.join()).toMatch(/none labeled/)
    expect(value(rows, 'spend cap|Tier 4|USD per month')).toBe(5_000)
  })

  it('reads the 2026 spend column as the spend cap, by its header', () => {
    const html =
      '<h2>Rate limits</h2><table><tr><th>Usage Tier</th><th>Credit Purchase</th><th>Monthly Spend Limit</th></tr>' +
      '<tr><td>Tier 1</td><td>$5</td><td>$100</td></tr></table>'
    expect(value(parseAnthropicLimitsHtml(html).rows, 'spend cap|Tier 1|USD per month')).toBe(100)
  })

  it('reads Build Tier 1 as Tier 1', () => {
    expect(tierName('Build Tier 1')).toBe('Tier 1')
  })

  it('refuses a copy with no usage-tier table', () => {
    expect(() => parseAnthropicLimitsHtml('<html><h2>Rate limits</h2></html>')).toThrow()
  })
})

describe('the limits eras', () => {
  it('never overlap and end by the live start', () => {
    const eras = [...LIMITS_ARCHIVE_ERAS].sort((a, b) => (a.from < b.from ? -1 : 1))
    eras.forEach((e, i) => {
      expect(e.from < e.until).toBe(true)
      expect(e.until <= LIMITS_LIVE_FROM).toBe(true)
      if (i > 0) expect(eras[i - 1]!.until <= e.from).toBe(true)
    })
  })

  it('writes one row per limit, keyed as the live recipe keys them', () => {
    const era = LIMITS_ARCHIVE_ERAS[0]!
    const out = limitsRows(
      era,
      { timestamp: '20240402100356', original: era.url, digest: 'x' },
      radio2024,
      radio2024.length,
      '2026-11-21T00:00:00.000Z',
    )
    expect(out.capture.status).toBe('parsed')
    expect(out.capture.axis).toBe('limits')
    expect(out.limits[0]).toMatchObject({ recipe_id: 'limits-anthropic', basis: 'archived' })
  })
})

describe('changes between archived copies', () => {
  const copy = (id: string, at: string) => ({
    id,
    provider: 'anthropic',
    captured_at: `${at}T12:00:00.000Z`,
    source_url: `https://web.archive.org/${id}`,
  })
  const row = (capture_id: string, v: number | null) => ({
    capture_id,
    recipe_id: 'limits-anthropic',
    key: 'spend cap|Tier 1|USD per month',
    model: 'spend cap',
    tier: 'Tier 1',
    metric: 'USD per month',
    value: v,
  })

  it('reads a raise between two copies, dated by a limits note in the window', () => {
    const changes = limitChanges(
      [copy('a', '2025-01-01'), copy('b', '2025-01-08')],
      [row('a', 100), row('b', 200)],
      [
        {
          provider: 'anthropic',
          date: '2025-01-05',
          url: 'u',
          title: 't',
          names: [],
          price: false,
          limits: true,
        },
      ],
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      before: 100,
      after: 200,
      date: '2025-01-05',
      window_days: 0,
    })
  })

  it('keeps the window without a note, and sizes no change against a none', () => {
    const changes = limitChanges(
      [copy('a', '2025-01-01'), copy('b', '2025-01-08'), copy('c', '2025-01-15')],
      [row('a', 100), row('b', 200), row('c', null)],
      [],
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ date: '2025-01-01', window_days: 7, dated_by: 'window' })
  })
})
