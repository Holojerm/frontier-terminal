// This app's tiers for its ops event kinds, registered with core's
// registry (server/utils/ops-severity.ts) by plugins/ops-severity.ts.
//
// The tiers are about what the owner has to do, not how alarming the word in
// the kind sounds:
//
// - critical — the product has stopped doing its job: no data is coming in,
//   no alert is being judged, or the site is failing requests wholesale (core
//   escalates server_error itself, at SERVER_ERROR_CRITICAL_COUNT). The
//   digest subject leads with [Critical]; filter on it to make the phone buzz.
// - warning — one part is degraded or stale. Worth a look today.
// - info — the system handled it, or it is a setup state already known. These
//   wait up to a day (OPS_INFO_HOLD_MS) unless something louder goes out first.
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
  all_sources_failed: {
    severity: 'critical',
    action:
      'Every source failed in one poll, so nothing on the site is updating. Usually egress or a bad deploy: open the logs and check /api/status.',
  },

  // ── warning ─────────────────────────────────────────────────────────────
  deploy_drift: {
    severity: 'warning',
    action:
      'A merge to main has not deployed. Check the latest Workers Builds run for a failed migrate or deploy step.',
  },
  poll_skipped: {
    severity: 'warning',
    action: 'A six-hourly survey was skipped; pricing and hiring are six hours staler.',
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
  class_map_changed: { severity: 'info' },
  class_basis_stale: { severity: 'info' },
  filed_facts_deferred: { severity: 'info' },
  source_unconfigured: { severity: 'info' },
}

export function registerTerminalOpsSeverity(): void {
  registerOpsSeverity(TERMINAL_OPS_SEVERITY)
}
