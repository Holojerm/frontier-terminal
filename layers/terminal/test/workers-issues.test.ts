import { afterEach, describe, expect, it } from 'vitest'

import { classifyOps, resetOpsSeverityForTest } from '../../../server/utils/ops-severity'
import { registerTerminalOpsSeverity } from '../server/utils/terminal-ops-severity'
import { workersIssueKind } from '../server/utils/workers-issues'

afterEach(() => resetOpsSeverityForTest())

// The texts Cloudflare sent production on 2026-11-07.
const TEST_PING =
  'Hello World! This is a test message sent from https://cloudflare.com. If you can see this, your webhook is configured correctly.'
const LOW_RISK_SCAN =
  "Real-Time Issue 'Potential vulnerability scan · wordpress · low risk' detected in frontier-terminal."

const severityOf = (body: Parameters<typeof workersIssueKind>[0]) => {
  registerTerminalOpsSeverity()
  return classifyOps(workersIssueKind(body), 1).severity
}

describe('workersIssueKind', () => {
  it("keeps Cloudflare's webhook test ping quiet", () => {
    expect(workersIssueKind({ text: TEST_PING })).toBe('workers_issue_test')
    expect(severityOf({ text: TEST_PING })).toBe('info')
  })

  it('keeps a low-risk vulnerability scan quiet', () => {
    expect(workersIssueKind({ text: LOW_RISK_SCAN })).toBe('workers_issue_scan')
    expect(severityOf({ text: LOW_RISK_SCAN })).toBe('info')
  })

  it('still pages for a scan rated above low risk', () => {
    const text = LOW_RISK_SCAN.replace('low risk', 'high risk')
    expect(severityOf({ text })).toBe('critical')
  })

  it('pages for a real failure', () => {
    const text = "Real-Time Issue 'Exceeded CPU time limit' detected in frontier-terminal."
    expect(workersIssueKind({ text })).toBe('workers_issue')
    expect(severityOf({ text })).toBe('critical')
  })

  it('marks the end of an issue as resolved', () => {
    expect(workersIssueKind({ text: 'x', alert_event: 'ALERT_STATE_EVENT_END' })).toBe(
      'workers_issue_resolved',
    )
  })

  it('pages when the payload carries no text at all', () => {
    expect(severityOf({})).toBe('critical')
  })
})
