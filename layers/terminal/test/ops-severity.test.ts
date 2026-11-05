import { describe, expect, it } from 'vitest'

import { classifyTerminalOps, SERVER_ERROR_CRITICAL_COUNT } from '../server/utils/ops-severity'

describe('classifyTerminalOps', () => {
  it('pages for the outages: a silent judge and a poll where every source failed', () => {
    expect(classifyTerminalOps('judge_silent', 1).severity).toBe('critical')
    expect(classifyTerminalOps('all_sources_failed', 1).severity).toBe('critical')
    expect(classifyTerminalOps('judge_silent', 1).action).toContain('/api/judge/pending')
  })

  it('escalates server errors only in a burst', () => {
    expect(classifyTerminalOps('server_error', 1).severity).toBe('warning')
    expect(classifyTerminalOps('server_error', SERVER_ERROR_CRITICAL_COUNT).severity).toBe(
      'critical',
    )
  })

  it('keeps the grounding check doing its job quiet', () => {
    expect(classifyTerminalOps('judge_rejected', 5).severity).toBe('info')
  })

  it('treats a kind it has never heard of as a warning, never as info', () => {
    expect(classifyTerminalOps('brand_new_failure', 1).severity).toBe('warning')
  })
})
