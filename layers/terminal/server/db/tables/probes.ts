import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from './columns'

// ─────────────────────────────────────────────
// Latency probes (layers/terminal/server/pipeline/probes/, /incidents#strain)
// ─────────────────────────────────────────────
// One row per probe: one fixed streaming request to one lab's flagship model,
// once an hour (probes:latency). Append-only. source_url is the endpoint the
// request went to and fetched_at when it was sent; raw_key is the R2 object
// holding every read of the response with its arrival time, the bytes the
// timings were derived from.
export const latencyProbes = sqliteTable(
  'latency_probes',
  {
    id: text('id').primaryKey(),
    lab: text('lab').notNull(),
    model: text('model').notNull(),
    route: text('route').notNull(), // openrouter
    // The provider slug the request was pinned to, and who the stream says served it.
    provider: text('provider').notNull(),
    served_by: text('served_by'),
    started_at: text('started_at').notNull(),
    // ok | rate_limited | failed | timeout | setup | router (pipeline/probes/stream.ts)
    outcome: text('outcome').notNull(),
    http_status: integer('http_status'),
    detail: text('detail'),
    provider_code: text('provider_code'),
    ttft_ms: integer('ttft_ms'),
    total_ms: integer('total_ms').notNull(),
    output_tokens: integer('output_tokens'),
    reasoning_tokens: integer('reasoning_tokens'),
    tokens_per_second: real('tokens_per_second'),
    finish_reason: text('finish_reason'),
    cost_usd: real('cost_usd'),
    generation_id: text('generation_id'),
    // Where the request left from: `cloudflare:<colo>`, or `local` off the Worker.
    ran_from: text('ran_from').notNull(),
    raw_key: text('raw_key'),
    ...provenance,
  },
  (t) => [
    index('latency_probes_started_idx').on(t.started_at),
    index('latency_probes_lab_started_idx').on(t.lab, t.started_at),
  ],
)

// One row per (lab, UTC day), re-rolled from latency_probes after every run
// for the days it touched: the strain reading the page and the API serve, so
// neither reads a quarter of raw probes. model is the day's newest; a day that
// changed model is rolled from the newest model's probes only.
export const probeDays = sqliteTable(
  'probe_days',
  {
    lab: text('lab').notNull(),
    day: text('day').notNull(), // YYYY-MM-DD, UTC
    model: text('model').notNull(),
    route: text('route').notNull(),
    // Probes that say something about the lab: every outcome but setup and router.
    probes: integer('probes').notNull(),
    ok: integer('ok').notNull(),
    rate_limited: integer('rate_limited').notNull(),
    failed: integer('failed').notNull(), // failed + timeout
    excluded: integer('excluded').notNull(), // setup + router
    peak_n: integer('peak_n').notNull(),
    offpeak_n: integer('offpeak_n').notNull(),
    // Medians over ok probes in each window; null under the minimum sample.
    peak_tps: real('peak_tps'),
    offpeak_tps: real('offpeak_tps'),
    peak_ttft_ms: real('peak_ttft_ms'),
    offpeak_ttft_ms: real('offpeak_ttft_ms'),
    // Medians over the whole day's ok probes.
    tps: real('tps'),
    ttft_ms: real('ttft_ms'),
    rolled_at: text('rolled_at').notNull(),
    ...provenance,
  },
  (t) => [primaryKey({ columns: [t.lab, t.day] }), index('probe_days_day_idx').on(t.day)],
)

export type LatencyProbeRow = typeof latencyProbes.$inferSelect

export type ProbeDayRow = typeof probeDays.$inferSelect
