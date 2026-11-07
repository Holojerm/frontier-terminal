// Which ops event kind a Workers Issues webhook call becomes
// (POST /api/ops/issues). The kind sets the tier (terminal-ops-severity.ts),
// and workers_issue is critical, so it is mailed at once. Two kinds of call
// are not failures and must not page:
//
//   - Cloudflare's "test message" when a webhook destination is saved;
//   - a low-risk vulnerability scan: a bot probing paths this Worker does not
//     serve (WordPress, .env). The first one paged on 2026-11-07.
//
// A scan Cloudflare rates above low risk stays critical: it may have found
// something.

export interface WorkersIssuePayload {
  name?: string
  text?: string
  alert_event?: string
}

export const WORKERS_ISSUE_KIND = 'workers_issue'
export const WORKERS_ISSUE_RESOLVED_KIND = 'workers_issue_resolved'
export const WORKERS_ISSUE_SCAN_KIND = 'workers_issue_scan'
export const WORKERS_ISSUE_TEST_KIND = 'workers_issue_test'

const TEST_MESSAGE = /\bthis is a test message\b/i
const SCAN = /\bpotential vulnerability scan\b/i
const LOW_RISK = /\blow risk\b/i

export function workersIssueKind(body: WorkersIssuePayload): string {
  const text = `${body.name ?? ''}\n${body.text ?? ''}`
  if (TEST_MESSAGE.test(text)) return WORKERS_ISSUE_TEST_KIND
  if (body.alert_event === 'ALERT_STATE_EVENT_END') return WORKERS_ISSUE_RESOLVED_KIND
  if (SCAN.test(text) && LOW_RISK.test(text)) return WORKERS_ISSUE_SCAN_KIND
  return WORKERS_ISSUE_KIND
}
