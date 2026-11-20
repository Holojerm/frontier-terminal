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
    '/api/adoption': 'not yet: adoption panels are on the lab page and /rankings only',
    '/api/datacenters': 'not yet: data-center power is on the lab page, /hiring and /compute only',
    '/api/disclosures': 'not yet: the disclosure summary is on the lab page and /disclosures only',
    '/api/limits': 'not yet: rate limits are on the lab page and /incidents only',
    '/api/parents':
      'not yet: on the lab page only; the sheet reads /api/exposure for the same filers',
    '/api/pay': 'not yet: posted pay is on the lab page and /hiring only',
    '/api/probes': 'not yet: measured strain is on the lab page and /incidents only',
    '/api/releases': 'not yet: new SKUs are on the lab page and /releases only',
    '/api/spend': 'not yet: implied spend share is on the lab page and /rankings only',
  },

  mcp: {
    '/api/page-data': 'internal: a page’s hydration payload for client navigation, not a dataset',
  },

  alerts: {
    '/api/adoption': 'not yet: recipe observations raise no alert',
    '/api/alerts': 'internal: the alert feed itself',
    '/api/alerts/[id]': 'internal: one alert of the feed',
    '/api/coverage': 'internal: source health; a failing source spools an ops event, not an alert',
    '/api/datacenters': 'not yet: recipe observations raise no alert',
    '/api/dependencies':
      'derived: joins filed exposure facts and prospectus commitments (sec, through /api/prospectus)',
    '/api/gpu-prices': 'not yet: GPU rental prices raise no alert',
    '/api/ground-truth':
      'derived: scores press reports against filings that alert on the revenue axis',
    '/api/identifiers': 'internal: reference data, read by hand',
    '/api/limits': 'not yet: recipe observations raise no alert',
    '/api/listed': 'derived: joins /api/dependencies, /api/suppliers and /api/power-sites',
    '/api/overview': 'derived: the signal band, built from the alert feed',
    '/api/page-data': 'internal: a page’s hydration payload, not a dataset',
    '/api/parents': 'not yet: recipe observations raise no alert',
    '/api/pay': 'not yet: recipe observations raise no alert',
    '/api/power-sites': 'not yet: a hand-read table that ships with the build',
    '/api/probes': 'not yet: latency strain raises no alert',
    '/api/prospectus':
      'covered: prospectus rows are sec and revenue change rows (ENTITY_AXIS), read in full on /revenue',
    '/api/releases': 'covered: a new SKU is a pricing change row (ENTITY_AXIS), read on /prices',
    '/api/reliability': 'internal: the feed’s own track record; failures spool ops events',
    '/api/reported': 'not yet: press headlines are judged for the track record, not alerted',
    '/api/spend': 'derived: joins OpenRouter share (demand) to list prices (pricing), both axes',
    '/api/suppliers': 'not yet: a hand-read table that ships with the build',
    '/api/theses': 'not yet: thesis status changes go to the weekly digest, not the alert feed',
    '/api/track-record': 'internal: grades the alerts; it cannot raise one',
    '/api/utilization': 'not yet: recipe observations raise no alert',
  },

  export: {
    api_keys: 'internal: licensee credentials (hashes)',
    bulk_grants: 'internal: S3 tokens for the licensed bucket',
    claim_status_changes:
      'not yet: the thesis revision trail; claim_verdicts and claim_readings are exported',
    class_map_decisions: 'internal: the judge’s overrides of the price matrix class map',
    deploy_checks: 'internal: post-deploy smoke runs, summarized on /api/reliability',
    filed_fact_reads: 'internal: the fetch log behind filed_facts',
    filing_detections: 'internal: EDGAR-to-alert timing, summarized on /api/reliability',
    filing_readings:
      'internal: the judge’s re-reads of filing parts; what it reads lands in the entity store',
    gdelt_files: 'internal: the GKG read cursor',
    gkg_mentions: 'internal: third-party GDELT rows kept for matching, then dropped',
    judge_runs: 'internal: the judge routine’s cursor',
    poll_ticks: 'internal: poll tick log behind the freshness gaps',
    price_readings:
      'internal: the judge’s re-reads of failing price pages; the prices land in prices_latest',
    recipe_runs: 'internal: the recipe fetch log; recipe_observations is exported',
    reported_reviews: 'internal: which headlines the judge has read',
    rollup_state: 'internal: how far the source_runs rollup has rolled',
    source_run_days: 'derived: a daily rollup of source_runs, which is exported',
    source_stats: 'derived: per-source counts of snapshots and source_runs, both exported',
    subscribers: 'internal: email addresses',
    task_heartbeats: 'internal: cron task liveness',
    track_record_searches: 'internal: the search log behind track_record_candidates',
    webhook_deliveries: 'internal: the webhook outbox',
    webhooks: 'internal: licensee webhook endpoints',
  },
} satisfies Waivers
