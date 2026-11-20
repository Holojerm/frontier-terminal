import { describe, expect, it } from 'vitest'

import { alertAxis, alertDelta, alertLabs, clipHeadline } from '../shared/utils/terminal-labs'
import type { ChangeView } from '../shared/utils/terminal-types'

const change = (over: Partial<ChangeView>): ChangeView => ({
  id: 'c',
  entity_key: 'k',
  entity_type: 'job',
  provider: 'openai',
  change_type: 'added',
  detected_at: '2026-09-20T06:00:00Z',
  summary: '',
  diff: [],
  source_url: 'https://example.com',
  fetched_at: '2026-09-20T06:00:00Z',
  ...over,
})

describe('alertLabs / alertAxis', () => {
  it('reads lab and axis off the cited rows, not the prose', () => {
    const alert = { changes: [change({}), change({ provider: 'openai' })] }
    expect(alertLabs(alert)).toEqual(['openai'])
    expect(alertAxis(alert)).toBe('hiring')
  })

  it('puts a filed hyperscaler fact on the exposure axis', () => {
    expect(alertAxis({ changes: [change({ entity_type: 'filed_fact' })] })).toBe('exposure')
  })

  it('puts a GPU rental median on the compute axis, with its move as the figure', () => {
    const alert = {
      changes: [
        change({
          entity_type: 'gpu_price',
          provider: 'other',
          change_type: 'modified',
          diff: [{ field: 'median', before: '4.75', after: '4.275' }],
        }),
      ],
    }
    expect(alertAxis(alert)).toBe('compute')
    expect(alertDelta(alert)).toBe('−10% median')
  })

  it('is null when the rows resolve to nothing or disagree', () => {
    expect(alertAxis({ changes: [] })).toBeNull()
    expect(
      alertAxis({ changes: [change({ entity_type: 'job' }), change({ entity_type: 'model' })] }),
    ).toBeNull()
  })

  it('reads a prospectus alert (revenue lines beside its offering and risk factors) as revenue', () => {
    // The 2026-11-19 424B4 prospectus-floor alert: one offering row, five revenue
    // rows, one risk-factors row. Two SEC axes, one filing: its Topic was "—".
    const alert = {
      changes: [
        change({ entity_type: 'offering', provider: 'anthropic' }),
        ...Array.from({ length: 5 }, () =>
          change({ entity_type: 'revenue', provider: 'anthropic' }),
        ),
        change({ entity_type: 'risk_factors', provider: 'anthropic' }),
      ],
    }
    expect(alertAxis(alert)).toBe('revenue')
    expect(alertAxis({ changes: [change({ entity_type: 'offering' })] })).toBe('sec')
    // Revenue beside an axis that isn't the filing's still disagrees.
    expect(
      alertAxis({
        changes: [change({ entity_type: 'revenue' }), change({ entity_type: 'job' })],
      }),
    ).toBeNull()
  })
})

describe('alertDelta', () => {
  it('nets a hiring batch', () => {
    const alert = {
      changes: [change({}), change({}), change({ change_type: 'removed' })],
    }
    expect(alertDelta(alert)).toBe('+2 −1 roles')
  })

  it('reads a reprice as a percent on the input price', () => {
    const alert = {
      changes: [
        change({
          entity_type: 'model',
          change_type: 'modified',
          diff: [{ field: 'input_per_mtok', before: '2', after: '1' }],
        }),
      ],
    }
    expect(alertDelta(alert)).toBe('−50% in')
  })

  it('names a listing and a delisting', () => {
    expect(alertDelta({ changes: [change({ entity_type: 'model' })] })).toBe('new SKU')
    expect(
      alertDelta({
        changes: [
          change({ entity_type: 'model', change_type: 'removed' }),
          change({ entity_type: 'model', change_type: 'removed' }),
        ],
      }),
    ).toBe('2 delisted')
  })

  it('has nothing to say about a filing', () => {
    expect(alertDelta({ changes: [change({ entity_type: 'filing' })] })).toBeNull()
  })
})

describe('clipHeadline', () => {
  it('cuts at a word and never mid-token', () => {
    const long =
      'xAI adds nine "Data Center" roles in one batch, all Memphis power-generation positions'
    const clipped = clipHeadline(long, 40)
    expect(clipped.length).toBeLessThanOrEqual(41)
    expect(clipped.endsWith('…')).toBe(true)
    expect(clipped).not.toMatch(/\s…$/)
  })

  it('leaves a short headline alone', () => {
    expect(clipHeadline('short')).toBe('short')
  })
})
