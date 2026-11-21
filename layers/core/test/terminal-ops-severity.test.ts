import { afterEach, describe, expect, it } from 'vitest'

import {
  classifyOps,
  resetOpsSeverityForTest,
  SERVER_ERROR_CRITICAL_COUNT,
} from '../../../server/utils/ops-severity'
import { registerTerminalOpsSeverity } from '../server/utils/terminal-ops-severity'

afterEach(() => resetOpsSeverityForTest())

describe('registerTerminalOpsSeverity', () => {
  it('pages for the outages: a silent judge and a poll where every source failed', () => {
    registerTerminalOpsSeverity()
    expect(classifyOps('judge_silent', 1).severity).toBe('critical')
    expect(classifyOps('all_sources_failed', 1).severity).toBe('critical')
    expect(classifyOps('judge_silent', 1).action).toContain('/api/judge/pending')
  })

  it("leaves server errors to core's burst rule", () => {
    registerTerminalOpsSeverity()
    expect(classifyOps('server_error', 1).severity).toBe('warning')
    expect(classifyOps('server_error', SERVER_ERROR_CRITICAL_COUNT).severity).toBe('critical')
  })

  it('keeps the grounding check doing its job quiet', () => {
    registerTerminalOpsSeverity()
    expect(classifyOps('judge_rejected', 5).severity).toBe('info')
  })

  it('treats a kind it has never heard of as a warning, never as info', () => {
    registerTerminalOpsSeverity()
    expect(classifyOps('brand_new_failure', 1).severity).toBe('warning')
  })
})
