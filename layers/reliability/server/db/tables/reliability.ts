import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// ─────────────────────────────────────────────
// Reliability (layers/reliability/server/pipeline/reliability/, /data#reliability)
// ─────────────────────────────────────────────
// What a due-diligence reviewer asks of the feed itself: how often each source
// answered, how stale the site got, how fast a filing reached an alert, and
// whether each deploy passed its smoke test. The reliability:record cron fills
// all four from stored rows and payloads; nothing here is typed by hand.

// One row per (source, UTC day), rolled up from source_runs so the page reads
// ~150 rows a day of history instead of every run. Re-rolled for today and
// yesterday each hour. A good run is ok, unchanged, baseline or absent (an
// answered check); a skipped run (no secret configured) is not counted.
// longest_gap_ms is the longest wait for a good run that ended this day,
// measured from the previous good run, whatever day that was.
export const sourceRunDays = sqliteTable(
  'source_run_days',
  {
    source_id: text('source_id').notNull(),
    day: text('day').notNull(), // YYYY-MM-DD, UTC
    runs: integer('runs').notNull(),
    good: integer('good').notNull(),
    first_good_at: text('first_good_at'),
    last_good_at: text('last_good_at'),
    // A gap is still open only while the source is still being checked.
    last_run_at: text('last_run_at').notNull(),
    longest_gap_ms: integer('longest_gap_ms'),
    gap_from: text('gap_from'),
    gap_to: text('gap_to'),
    rolled_at: text('rolled_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.source_id, t.day] }),
    index('source_run_days_day_idx').on(t.day),
  ],
)

// One row per poll tick (scope, started_at): how many sources it ran and how
// many answered. The freshness gaps on /data#reliability are the spaces
// between ticks where most sources answered.
export const pollTicks = sqliteTable(
  'poll_ticks',
  {
    scope: text('scope').notNull(),
    started_at: text('started_at').notNull(),
    runs: integer('runs').notNull(),
    good: integer('good').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.started_at] }),
    index('poll_ticks_started_idx').on(t.started_at),
  ],
)

// One row per filing a rule alert cited (DETECTION_RULES): the first such
// alert, and EDGAR's acceptance time read back from the submissions JSON or
// filing index page already stored in R2 (never a new SEC fetch). status
// 'missing' records that no stored payload listed it; the cron retries those
// for two days, then stops. filing_date is EDGAR's, which for a filing
// accepted after 5:30 p.m. Eastern is the next business day.
export const filingDetections = sqliteTable(
  'filing_detections',
  {
    accession_no: text('accession_no').primaryKey(),
    cik: text('cik').notNull(),
    form: text('form'),
    alert_id: text('alert_id').notNull(),
    rule: text('rule').notNull(),
    headline: text('headline').notNull(),
    alerted_at: text('alerted_at').notNull(),
    status: text('status').notNull(), // found | missing
    accepted_at: text('accepted_at'),
    filing_date: text('filing_date'),
    basis: text('basis'), // submissions | filing-index
    snapshot_id: text('snapshot_id'),
    source_url: text('source_url'),
    fetched_at: text('fetched_at'),
    recorded_at: text('recorded_at').notNull(),
  },
  (t) => [
    index('filing_detections_alerted_idx').on(t.alerted_at),
    index('filing_detections_recorded_idx').on(t.recorded_at),
  ],
)

// One row per run of the post-deploy smoke workflow on main
// (.github/workflows/post-deploy-smoke.yml), read from GitHub's public
// Actions API. Upserted by run id: a run seen in progress is rewritten when
// it completes. source_url is the API page it was read from.
export const deployChecks = sqliteTable(
  'deploy_checks',
  {
    run_id: text('run_id').primaryKey(),
    head_sha: text('head_sha').notNull(),
    status: text('status').notNull(), // queued | in_progress | completed
    conclusion: text('conclusion'), // success | failure | cancelled | … ; null until completed
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
    html_url: text('html_url').notNull(),
    source_url: text('source_url').notNull(),
    fetched_at: text('fetched_at').notNull(),
  },
  (t) => [
    index('deploy_checks_created_idx').on(t.created_at),
    // reliabilityStamp() reads max(fetched_at) on every /api/reliability request.
    index('deploy_checks_fetched_idx').on(t.fetched_at),
  ],
)
