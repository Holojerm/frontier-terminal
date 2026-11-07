// This app's tiers for its ops event kinds, registered with core's
// registry (server/utils/ops-severity.ts) by plugins/ops-severity.ts.
//
// The tiers are about what the owner has to do, not how alarming the word in
// the kind sounds:
//
// - critical — the product has stopped doing its job: no data is coming in,
//   no alert is being judged, or the site is failing requests wholesale (core
//   escalates server_error itself, at SERVER_ERROR_CRITICAL_COUNT). Mailed at
//   once, one email per kind per cooldown (ops-throttle.ts); the subject
//   leads with [Critical], so a filter on it can make the phone buzz.
// - warning — one part is degraded or stale. Worth a look today: listed in
//   the daily digest, once per failure streak.
// - info — the system handled it, or it is a setup state already known.
//   Listed in the daily digest only when a warning sends it anyway.
//
// A kind missing from the table is a warning: a new failure path should be
// seen before anyone decides it can be quiet. Add a kind here when you add its
// recordOpsEvent call.

import type { OpsKindPolicy } from '#server/utils/ops-digest'
import { registerOpsSeverity } from '#server/utils/ops-severity'

export const TERMINAL_OPS_SEVERITY: Record<string, OpsKindPolicy> = {
  // ── critical ────────────────────────────────────────────────────────────
  judge_silent: {
    severity: 'critical',
    action:
      "No alerts are being published. Open the frontier-terminal-judge routine's latest session at claude.ai/code/routines; a 403 on /api/judge/pending means its environment's network allowlist lost the Worker host.",
  },
  // Critical so it is mailed at once (ops-immediate.ts): Issues fires on a new
  // kind of failure, and it is the only signal for a failure that spools
  // nothing else, like a request that never returns. Repeats inside the
  // cooldown are not mailed again.
  workers_issue: {
    severity: 'critical',
    action:
      'Workers Issues found a new or returning failure. Open the Issues tab for frontier-terminal in the Cloudflare dashboard for the stack and the failing requests.',
  },
  workers_issue_resolved: { severity: 'info' },
  // Not failures; see workers-issues.ts.
  workers_issue_scan: { severity: 'info' },
  workers_issue_test: { severity: 'info' },
  all_sources_failed: {
    severity: 'critical',
    action:
      'Every source failed in one poll, so nothing on the site is updating. Usually egress or a bad deploy: open the logs and check /api/status.',
  },

  // ── warning ─────────────────────────────────────────────────────────────
  // The freshness checks (freshness.ts, terminal-freshness.ts): work is owed
  // and the part that does it has gone quiet. judge_silent above is the same
  // rule, louder, because nothing is published without the judge.
  task_silent: {
    severity: 'warning',
    action:
      'A scheduled task has not completed a run in its window. Look for it in the Worker logs (Logs link below); a cron string out of step with wrangler.toml shows up in `bun run crons:check`.',
  },
  gdelt_search_silent: {
    severity: 'warning',
    action:
      "No GDELT file has been read while files are due. Open GitHub › Actions › GDELT search: if its runs stopped, start one with 'Run workflow'; if they run, read the log for a failed file fetch or a 4xx from /api/gdelt/*.",
  },
  press_drafts_silent: {
    severity: 'warning',
    action:
      "A press note has waited past its window. Open the press-drafts routine's latest session at claude.ai/code/routines.",
  },
  social_outbox_stalled: {
    severity: 'warning',
    action:
      'A due social post has stayed queued for an hour. Look for events_queue_failed or events_emit_failed in the Worker logs; the hourly events:sweep should have sent it, so check that task too.',
  },
  freshness_check_failed: { severity: 'warning' },
  deploy_drift: {
    severity: 'warning',
    action:
      'A merge to main has not deployed. Check the latest Workers Builds run for a failed migrate or deploy step.',
  },
  poll_skipped: {
    severity: 'warning',
    action:
      'A six-hourly survey was skipped; hiring and the other survey-only sources are six hours staler. Price lists and catalogs keep their 30- and 5-minute polls.',
  },
  launch_unalerted: { severity: 'warning' },
  class_basis_still_stale: { severity: 'warning' },
  source_failed: { severity: 'warning' },
  source_absent: { severity: 'warning' },
  filed_facts_failed: { severity: 'warning' },
  filed_facts_run_failed: { severity: 'warning' },
  recipe_failed: { severity: 'warning' },
  recipes_run_failed: { severity: 'warning' },
  theses_evaluate_failed: { severity: 'warning' },
  thesis_digest_failed: { severity: 'warning' },
  bulk_build_failed: { severity: 'warning' },
  reliability_record_failed: { severity: 'warning' },
  hiring_rollup_failed: { severity: 'warning' },
  track_record_search_failed: { severity: 'warning' },
  press_brief_failed: { severity: 'warning' },
  webhook_failing: { severity: 'warning' },
  social_failed: { severity: 'warning' },
  social_unknown: {
    severity: 'warning',
    action:
      'A post may or may not have gone out. Check Buffer, then set the row to sent or queued.',
  },

  // ── info ────────────────────────────────────────────────────────────────
  // The grounding check doing its job: the judge proposed something it could
  // not back, and the Worker refused it. Persistent staleness from that shows
  // up separately as class_basis_still_stale.
  judge_rejected: { severity: 'info' },
  // A failure streak the daily digest reported has gone quiet (ops-throttle.ts).
  ops_recovered: { severity: 'info' },
  class_map_changed: { severity: 'info' },
  class_basis_stale: { severity: 'info' },
  filed_facts_deferred: { severity: 'info' },
  source_unconfigured: { severity: 'info' },
}

export function registerTerminalOpsSeverity(): void {
  registerOpsSeverity(TERMINAL_OPS_SEVERITY)
}
