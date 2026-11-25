// Every surface a dataset does not reach, and why, for `bun run surfaces:check`
// (scripts/check-surfaces.ts). The gate fails on a gap missing from here and on a
// waiver whose gap is gone, so this file is always exactly today's gaps.
//
// Keys: the route's URL (`/api/prices/[key]`) or the table's SQL name. A reason
// is one line and starts with its kind:
//   internal:  never public (credentials, cursors, run logs, a page's own payload)
//   derived:   the rows reach this surface through another route or table
//   covered:   reached another way the gate cannot see; say which
//   not yet:   a gap someone should close; delete the waiver in the PR that does
//
// How to read the matrix and add one: .claude/docs/surfaces.md.

import type { Waivers } from './scripts/lib/surfaces'

export const SURFACE_WAIVERS = {
  page: {
    '/api/hiring':
      'covered: /hiring and the lab page read /api/hiring/history; this is the current-count API and get_hiring',
    '/api/identifiers':
      'not yet: the security master is linked from /data and served by get_identifiers; no page renders it',
  },

  labPage: {
    '/api/exposure':
      'not yet: the hyperscaler lines naming the lab are on the tear sheet and /exposure only',
  },

  tearSheet: {
    '/api/parents':
      'derived: the same investee-member facts are /api/exposure’s openai and anthropic series, which the sheet prints as hyperscaler filings',
  },

  mcp: {
    '/api/page-data': 'internal: a page’s hydration payload for client navigation, not a dataset',
  },

  alerts: {
    '/api/call-guidance':
      'not yet: a scored call statement raises no alert; its surprise is a /signals event',
    '/api/alerts': 'internal: the alert feed itself',
    '/api/alerts/[id]': 'internal: one alert of the feed',
    '/api/coverage': 'internal: source health; a failing source spools an ops event, not an alert',
    '/api/dependencies':
      'derived: joins filed exposure facts and prospectus commitments (sec, through /api/prospectus)',
    '/api/grid-load': 'not yet: a load reading raises no alert',
    '/api/ground-truth':
      'derived: scores press reports against filings (revenue axis) and capex guidance against filed capex (exposure axis, guidance-floor)',
    '/api/identifiers': 'internal: reference data, read by hand',
    '/api/listed':
      'derived: joins /api/dependencies, /api/suppliers, /api/power-sites and the /api/prints ties',
    '/api/overview': 'derived: the signal band, built from the alert feed',
    '/api/page-data': 'internal: a page’s hydration payload, not a dataset',
    '/api/parents':
      'covered: the facts that move (stake, funding, revenue, receivables, gains, credit lines) are read from the same filings as filed-fact-floor series (exposure axis) and alert there; a second rule on the recipe rows would alert twice',
    '/api/power-sites':
      'not yet: a new tie raises no alert, like a new supplier passage (docs/alerts-expansion.md › 6)',
    '/api/probes': 'not yet: latency strain raises no alert',
    '/api/prints':
      'not yet: a new month or a revision raises no alert; the signal registry grades the series instead',
    '/api/prospectus':
      'covered: prospectus rows are sec and revenue change rows (ENTITY_AXIS), read in full on /revenue',
    '/api/releases': 'covered: a new SKU is a pricing change row (ENTITY_AXIS), read on /prices',
    '/api/reliability': 'internal: the feed’s own track record; failures spool ops events',
    '/api/signals':
      'internal: scores the other datasets against stock returns; it raises no alert of its own',
    '/api/reported': 'not yet: press headlines are judged for the track record, not alerted',
    '/api/spend': 'derived: joins OpenRouter share (demand) to list prices (pricing), both axes',
    '/api/suppliers':
      'not yet: a judge-read passage raises no alert (docs/alerts-expansion.md › 6)',
    '/api/theses': 'not yet: thesis status changes go to the weekly digest, not the alert feed',
    '/api/track-record': 'internal: grades the alerts; it cannot raise one',
    '/api/utilization': 'not yet: recipe observations raise no alert',
  },

  export: {
    alert_cites:
      'derived: the lab and entity type of each alert’s cited changes; alerts and changes are exported',
    api_keys: 'internal: licensee credentials (hashes)',
    bulk_grants: 'internal: S3 tokens for the licensed bucket',
    class_map_decisions: 'internal: the judge’s overrides of the price matrix class map',
    deploy_checks: 'internal: post-deploy smoke runs, summarized on /api/reliability',
    filed_fact_reads: 'internal: the fetch log behind filed_facts',
    filing_detections: 'internal: EDGAR-to-alert timing, summarized on /api/reliability',
    filing_readings:
      'internal: the judge’s re-reads of filing parts; what it reads lands in the entity store',
    gdelt_archive_files: 'internal: the read cursor for GKG files before GKG_FROM',
    gdelt_files: 'internal: the GKG read cursor',
    gkg_mentions: 'internal: third-party GDELT rows kept for matching, then dropped',
    ercot_large_load_reports:
      'internal: the ERCOT reader’s fetch log; each ercot_large_load_facts row names its report',
    grid_load_files:
      'internal: the EIA-930 reader’s fetch log; each grid_load_days row names its file',
    judge_runs: 'internal: the judge routine’s cursor',
    market_bars:
      'internal: Databento closes licensed for internal use only; signal_results exports what is derived from them',
    market_fetches: 'internal: the Databento pull cursor behind market_bars',
    poll_ticks: 'internal: poll tick log behind the freshness gaps',
    price_readings:
      'internal: the judge’s re-reads of failing price pages; the prices land in prices_latest',
    recipe_runs: 'internal: the recipe fetch log; recipe_observations is exported',
    reported_reviews: 'internal: which headlines the judge has read',
    rollup_state: 'internal: how far the source_runs rollup has rolled',
    signal_runs: 'internal: the signals harness’s run log; signal_results is exported',
    source_run_days: 'derived: a daily rollup of source_runs, which is exported',
    row_counts:
      'derived: per-key row counts of entities, changes, alerts and recipe_observations, all exported',
    source_stats: 'derived: per-source counts of snapshots and source_runs, both exported',
    subscribers: 'internal: email addresses',
    print_documents:
      'internal: the print reader’s fetch log; each hardware_prints row names its document',
    power_site_documents:
      'internal: the power-sites reader’s fetch log; each power_site_ties row names its filing',
    supplier_documents:
      'internal: the suppliers reader’s fetch log; each supplier_passages row names its document',
    task_heartbeats: 'internal: cron task liveness',
    track_record_searches: 'internal: the search log behind track_record_candidates',
    webhook_deliveries: 'internal: the webhook outbox',
    webhooks: 'internal: licensee webhook endpoints',
  },
} satisfies Waivers
