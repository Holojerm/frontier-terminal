import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Task plumbing every layer's scheduled work shares: how far a rollup has
// rolled, and when each task last ran.

// How far a rollup has rolled: one row per rollup. The reliability layer's
// source_run_days rollup is the one, name 'source_runs'.
// rolled_through is the instant every run before it is counted; the page
// computes nothing past it, so a backfill in progress never reads as an outage.
// started is the first day the rollup holds.
export const rollupState = sqliteTable('rollup_state', {
  name: text('name').primaryKey(),
  rolled_through: text('rolled_through').notNull(),
  started: text('started').notNull(),
  updated_at: text('updated_at').notNull(),
})

// ─────────────────────────────────────────────
// Task heartbeats
// ─────────────────────────────────────────────
// One row per scheduled task: when it last ran to completion and when it last
// threw. Every task file wraps its definition in withHeartbeat()
// (layers/core/server/utils/task-heartbeat.ts), which upserts this row when the
// run ends. The freshness checks (layers/core/server/utils/freshness.ts) read it
// to see a task that stopped running at all: a cron that no longer fires, a
// run killed at the CPU limit, a task that throws every tick. A task that
// catches its own failure and returns still counts as completed here; its
// failure is the job of its own ops event.
//
// first_seen_at is written once, on the first run this table records, and
// never moved: its minimum across rows is when monitoring started, so a task
// that has never run is measured from then rather than from the epoch.
export const taskHeartbeats = sqliteTable('task_heartbeats', {
  task: text('task').primaryKey(),
  first_seen_at: text('first_seen_at').notNull(),
  last_started_at: text('last_started_at').notNull(),
  last_completed_at: text('last_completed_at'),
  last_failed_at: text('last_failed_at'),
  last_error: text('last_error'),
})
