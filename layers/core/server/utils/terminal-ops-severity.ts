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
//   show on the board only; fleet never mails them.
//
// A kind missing from the table is a warning: a new failure path should be
// seen before anyone decides it can be quiet. Add a kind here when you add its
// recordOpsEvent call.

import type { OpsKindPolicy } from '#server/utils/ops-severity'
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
  // The freshness checks (freshness.ts, terminal-freshness.ts): work is owed
  // and the part that does it has gone quiet. judge_silent above is the same
  // rule, louder, because nothing is published without the judge.
  task_silent: {
    severity: 'warning',
    action:
      'A scheduled task has not completed a run in its window. Look for it in the Worker logs (Logs link below); a cron string out of step with wrangler.toml shows up in `bun run crons:check`.',
  },
  // Spooled by withHeartbeat (task-heartbeat.ts) for any scheduled task that throws.
  task_failed: {
    severity: 'warning',
    action:
      'A scheduled task threw; the detail names it and the error. If it keeps throwing it goes silent too, and task_silent follows.',
  },
  gdelt_search_silent: {
    severity: 'warning',
    action:
      "No GDELT file has been read while files are due. On the Mac mini, read ~/agent-jobs/logs/gdelt-search.log for a failed file fetch or a 4xx from /api/gdelt/*, and check `launchctl print gui/$(id -u)/com.holojerm.job.gdelt-search`. If the mini is down, start GitHub › Actions › GDELT search with 'Run workflow'.",
  },
  social_outbox_stalled: {
    severity: 'warning',
    action:
      'A due social post has stayed queued for an hour. Look for events_queue_failed or events_emit_failed in the Worker logs; the hourly events:sweep should have sent it, so check that task too.',
  },
  listing_status_stale: {
    severity: 'warning',
    action:
      'A filer listed as "registered" has filed its final prospectus (424B4), so the site still says its shares are not trading. Check the listing, then update its rows in layers/terminal/server/utils/terminal-identifiers.ts and terminal-entities.ts (listing_status, exchange, note).',
  },
  freshness_check_failed: { severity: 'warning' },
  // tasks/probes/latency.ts: a latency probe was refused for a reason of ours.
  probe_setup_failed: {
    severity: 'warning',
    action:
      'OpenRouter refused a latency probe. The detail has its code: 402 means the account is out of credit, 401 or 403 the key, 404 that the model or its first-party endpoint is gone (a flagship target picks its model from the next OpenRouter catalog; a pinned one needs PROBE_TARGETS updated), 400 that the request needs changing, and “unreadable reply” that the stream reader (pipeline/probes/stream.ts) no longer matches what OpenRouter sends (the R2 trace under probes/ has the bytes). No reading is stored for those labs until it is fixed.',
  },
  // utils/probe-runner.ts: the probes run inside a Durable Object with a location hint.
  probe_unpinned: {
    severity: 'warning',
    action:
      'The probes:latency cron found no PROBES Durable Object binding, so it probed nothing rather than probe from whichever colo ran it. Check wrangler.toml › Probe placement and that nuxt.config.ts still builds with the cloudflare-durable preset, then redeploy. The hours missed cannot be backfilled.',
  },
  probe_placement_failed: {
    severity: 'warning',
    action:
      'The probes Durable Object for the placement in the detail did not return a report, so that placement may have stored no probes this hour. The detail has its status or error; look in the Worker logs for the /_probes/run request inside the object. The hours missed cannot be backfilled.',
  },
  // tasks/signals/prices.ts: a Databento pull failed.
  market_pull_failed: {
    severity: 'warning',
    action:
      'A Databento pull for the signals harness failed. The detail has Databento’s message: 401 means DATABENTO_API_KEY is wrong or unset, 402 or 403 that credits ran out or the dataset needs a licence. The harness keeps scoring on the closes it already has.',
  },
  // pipeline/probes/resolve.ts: a flagship target's model is chosen on every run.
  probe_model_unresolved: {
    severity: 'warning',
    action:
      'A lab was not probed this run because no model in the stored OpenRouter catalog (openrouter-models) matches its flagship in the class map, or the match has no fixed price. The detail names the lab and the class-map slug. Check that openrouter-models is polling, and whether OpenRouter lists the flagship under another id; if the class map is stale, its drift check should already have flagged the cell.',
  },
  probe_over_budget: {
    severity: 'warning',
    action:
      'A lab was not probed this run because its flagship’s OpenRouter list price would take the hourly probes over PROBE_MONTHLY_BUDGET_USD (pipeline/probes/targets.ts). The detail has the model, its price and the month it would cost. Raise the budget or trim the workload; until then that lab’s readings stop.',
  },
  // judge/price-review.ts: a published price now rests on the judge's reading
  // of a page, not on a parser.
  price_read_by_judge: {
    severity: 'warning',
    action:
      'The price list named in the detail has a failing parser, and the judge read these prices from the page instead. Check them against the page; the quotes are in price_readings. The parser fix (ops-triage opens it for source_failed) re-reads the page and corrects any that are wrong.',
  },
  deploy_drift: {
    severity: 'warning',
    action:
      'A merge to main has not deployed. Check the latest Workers Builds run for a failed migrate or deploy step.',
  },
  // reliability:deploys reads the smoke runs anyway; GitHub mails a failure to
  // whoever triggered the run, which under the merge queue is a bot.
  deploy_smoke_failed: {
    severity: 'warning',
    action:
      'Production failed its post-deploy smoke test. Open the run linked in the detail for the failing check.',
  },
  poll_skipped: {
    severity: 'warning',
    action:
      'A six-hourly survey was skipped; hiring and the other survey-only sources are six hours staler. Price lists and catalogs keep their 30- and 5-minute polls.',
  },
  class_basis_still_stale: { severity: 'warning' },
  source_failed: { severity: 'warning' },
  source_part_failed: { severity: 'warning' },
  source_absent: { severity: 'warning' },
  filed_facts_failed: { severity: 'warning' },
  filed_facts_run_failed: { severity: 'warning' },
  // The suppliers reader (layers/terminal/server/suppliers/ingest.ts): a feed
  // it could not parse, a 429, or the run itself throwing.
  supplier_read_failed: { severity: 'warning' },
  // The power-sites reader (layers/compute/server/power/ingest.ts): a search
  // it could not run or parse, a 429, or the run itself throwing.
  power_site_read_failed: { severity: 'warning' },
  // The print reader (layers/compute/server/prints/ingest.ts): a feed or 6-K
  // it could not fetch or parse, a 429, or a step throwing.
  print_read_failed: { severity: 'warning' },
  // The call reader (layers/terminal/server/calls/ingest.ts): a document it
  // could not fetch after three tries, an EDGAR read, or a step throwing.
  call_read_failed: { severity: 'warning' },
  // AssemblyAI refused for credits or billing, or the $40 spend cap was
  // reached: replays stop being submitted until the owner acts.
  assemblyai_credits: { severity: 'warning' },
  // The weekly re-check (layers/compute/server/power/verify.ts): a hand-read
  // quote is no longer on its utility, regulator or company page.
  power_quote_gone: { severity: 'warning' },
  // The grid-load reader (layers/compute/server/power/grid-load.ts and
  // ercot-large-loads.ts): an EIA-930 file or an ERCOT report it could not
  // fetch or read, or ERCOT's listing pages linking no report.
  grid_load_read_failed: { severity: 'warning' },
  // The listed companies' job boards (layers/terminal/server/listed-hiring/read.ts):
  // a board that answered an error, a payload its reader did not recognise, or
  // a board that emptied at once. Each names the board.
  listed_hiring_read_failed: { severity: 'warning' },
  // A stored capex-guidance sentence is not in its stored release, or no
  // longer reads as its figure: the parser and the store disagree.
  guidance_unverified: { severity: 'warning' },
  // tasks/signals/run.ts: recording or settling the forward calls threw. The
  // harness still ran; calls whose window passes while this fails are not
  // recorded, and scores land on the next good run.
  forward_calls_failed: {
    severity: 'warning',
    action:
      'Recording or settling the forward calls threw (layers/terminal/server/signals/forward-rules.ts). The detail has the error. A prints call whose 14-day window passes before a fix is lost for that quarter; scores are written on the next good run.',
  },
  recipe_failed: { severity: 'warning' },
  recipes_run_failed: { severity: 'warning' },
  gpu_median_alerts_failed: { severity: 'warning' },
  theses_evaluate_failed: { severity: 'warning' },
  bulk_build_failed: { severity: 'warning' },
  reliability_record_failed: { severity: 'warning' },
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
