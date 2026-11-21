import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Task plumbing every layer's scheduled work shares: how far a rollup has
// rolled, and when each task last ran.

// How far a rollup has rolled: one row per rollup (the reliability layer's
// source_run_days rollup, name 'source_runs'). Every run before rolled_through
// is counted; the page computes nothing past it, so a backfill in progress
// never reads as an outage. started is the first day the rollup holds.
export const rollupState = sqliteTable('rollup_state', {
  name: text('name').primaryKey(),
  rolled_through: text('rolled_through').notNull(),
  started: text('started').notNull(),
  updated_at: text('updated_at').notNull(),
})

// ─────────────────────────────────────────────
// Task heartbeats
// ─────────────────────────────────────────────
// One row per scheduled task: its last completion and last throw, upserted by
// withHeartbeat() (layers/core/server/utils/task-heartbeat.ts). The freshness
// checks (layers/core/server/utils/freshness.ts) read it to catch a task that
// stopped running. A task that catches its own failure still counts as
// completed. first_seen_at is never moved: its minimum is when monitoring
// began, the baseline for a task that has never run.
export const taskHeartbeats = sqliteTable('task_heartbeats', {
  task: text('task').primaryKey(),
  first_seen_at: text('first_seen_at').notNull(),
  last_started_at: text('last_started_at').notNull(),
  last_completed_at: text('last_completed_at'),
  last_failed_at: text('last_failed_at'),
  last_error: text('last_error'),
})
