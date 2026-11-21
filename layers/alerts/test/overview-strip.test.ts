import { describe, expect, it } from 'vitest'

import { overviewStrip, slimAlerts } from '../app/utils/overview-strip'

const alert = (id: string, at: string, provider: string) =>
  ({
    id,
    created_at: at,
    explanation: 'long text',
    changes: [
      {
        provider,
        entity_type: 'model',
        change_type: 'added',
        summary: 'x',
        diff: [{ field: 'name' }],
      },
    ],
  }) as never

describe('overviewStrip', () => {
  it('keeps the band rows, the newest info, and each lab’s newest alert, and drops the rest', () => {
    const alerts = [
      ...[6, 5, 4, 3, 2].map((n) => alert(`a${n}`, `2026-11-0${n}`, 'openai')),
      alert('old-anthropic', '2026-10-01', 'anthropic'),
      alert('old-openai', '2026-10-02', 'openai'),
    ]
    const info = [alert('i2', '2026-11-07', 'xai'), alert('i1', '2026-10-30', 'xai')]
    const out = overviewStrip({ alerts, info, alert_count: 7, info_count: 2 } as never, [
      'openai',
      'anthropic',
      'xai',
    ])
    expect(out.alerts.map((a) => a.id)).toEqual(['a6', 'a5', 'a4', 'a3', 'a2', 'old-anthropic'])
    expect(out.info.map((a) => a.id)).toEqual(['i2'])
    expect(out.alert_count).toBe(7)
    expect(out.alerts[0]!.explanation).toBe('')
    expect(out.alerts[0]!.changes[0]).toMatchObject({ provider: 'openai', summary: '', diff: [] })
  })
})

describe('slimAlerts', () => {
  it('shares one object between equal slimmed changes, and keeps what alertDelta counts', () => {
    const job = (id: string, change_type: string) => ({
      id,
      provider: 'anthropic',
      entity_type: 'job',
      change_type,
      summary: `role ${id}`,
      diff: [],
    })
    const [a] = slimAlerts([
      {
        id: 'a',
        explanation: 'long text',
        changes: [job('1', 'added'), job('2', 'added'), job('3', 'removed')],
      } as never,
    ])
    expect(a!.changes[0]).toBe(a!.changes[1])
    expect(a!.changes[2]).not.toBe(a!.changes[0])
    expect(alertDelta(a!)).toBe('+2 −1 roles')
  })
})
