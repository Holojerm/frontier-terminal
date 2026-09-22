import { describe, expect, it } from 'vitest'

import { LAB_PAGES, isLab, summarizeLab } from '../shared/utils/terminal-lab-summary'
import type { HiringHistoryData } from '../shared/utils/terminal-types'

const hiring: HiringHistoryData = {
  as_of: null,
  computed_at: '2026-09-20T06:00:00Z',
  window_days: 30,
  log: { changes: 0, from: null, to: null },
  providers: [
    {
      provider: 'xai',
      display: 'xAI',
      feed: 'ok',
      reason: null,
      caveat: 'blend',
      dates: ['2026-09-19', '2026-09-20'],
      total: [42, 39],
      departments: [],
      clusters: [],
      compare: { at: '2026-09-19', days: 1, total_then: 42, total_now: 39, departments: [] },
      series_from: null,
      baseline_at: null,
      join_from: null,
      sources: [],
    },
    {
      provider: 'google',
      display: 'Google',
      feed: 'no_public_feed',
      reason: 'cut',
      caveat: null,
      dates: [],
      total: [],
      departments: [],
      clusters: [],
      compare: null,
      series_from: null,
      baseline_at: null,
      join_from: null,
      sources: [],
    },
  ],
}

describe('summarizeLab', () => {
  it('reads open roles and the delta off the history series', () => {
    const s = summarizeLab('xai', { hiring })
    expect(s.hiring.now).toBe(39)
    expect(s.hiring.delta).toBe(-3)
    expect(s.hiring.days).toBe(1)
  })

  it('is null, not zero, for a board with no feed', () => {
    const s = summarizeLab('google', { hiring })
    expect(s.hiring.now).toBeNull()
    expect(s.hiring.view?.feed).toBe('no_public_feed')
  })

  it('is empty-handed without payloads rather than throwing', () => {
    const s = summarizeLab('openai', {})
    expect(s.flagship).toBeNull()
    expect(s.alerts).toEqual([])
  })
})

describe('lab pages', () => {
  it('lists the four labs with a summary a crawler can read', () => {
    expect(LAB_PAGES.map((p) => p.path)).toEqual([
      '/labs/openai',
      '/labs/anthropic',
      '/labs/google',
      '/labs/xai',
    ])
    expect(isLab('xai')).toBe(true)
    expect(isLab('mistral')).toBe(false)
  })
})
