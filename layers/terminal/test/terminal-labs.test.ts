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

  it('is null when the rows resolve to nothing or disagree', () => {
    expect(alertAxis({ changes: [] })).toBeNull()
    expect(
      alertAxis({ changes: [change({ entity_type: 'job' }), change({ entity_type: 'model' })] }),
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
