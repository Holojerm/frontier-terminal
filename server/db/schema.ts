import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// ─────────────────────────────────────────────
// Database Schema (Drizzle ORM + Cloudflare D1)
// ─────────────────────────────────────────────
// Convention:
//   - Table names: snake_case plural (e.g. ops_events)
//   - Column names: snake_case
//   - All tables have: id, created_at, and updated_at — unless the table is
//     append-only, in which case updated_at is omitted rather than lied about
//   - Foreign keys: <table_singular>_id (e.g. provider_id)
//
// This site has no accounts. The two tables below are the ops substrate the
// template shipped with; the data pipeline adds its own tables beside them.
// ─────────────────────────────────────────────

// Timestamps helper — spread into every table
const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date())
    .notNull(),
}

// Instance secrets — server-generated derivation salts, one row each.
//
// A salt that must be stable for the life of the deployment cannot be derived
// from an operator-rotatable secret, and making it its own env var is a setup
// step every fork would have to remember. So it is generated here, once, at
// random, and never rotated (server/utils/identity.ts).
//
// Server-generated derivation material ONLY. Never user input, never anything
// rendered, never anything a request can name — an id here is chosen by code in
// this repo, so this table can never become a generic key/value store that a
// handler writes into. It holds no personal data and is not exported.
export const instanceSecrets = sqliteTable('instance_secrets', {
  // A constant chosen in code, e.g. IDENTITY_SALT_ID. Not user-supplied.
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .notNull(),
})

// Ops events — the alerting spool. Anything that should wake the owner up gets
// a row here, and server/tasks/ops/alert.ts drains it on a cron and emails a
// digest. This exists because Workers Logs cannot be alerted on: the only
// component that knows a request blew up is the Worker itself, at the moment
// it happens — so it writes the fact down where a cron can find it.
//
// `notified_at` is the drain marker, not a timestamp anyone reads: NULL means
// "still owed an email". Indexed because the cron filters on it every tick.
export const opsEvents = sqliteTable(
  'ops_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    kind: text('kind').notNull(), // a `kind` from the log taxonomy, e.g. server_error
    detail: text('detail'), // one-line human summary — goes in the email body
    path: text('path'), // request path, when there was one (query already stripped)
    notifiedAt: integer('notified_at', { mode: 'timestamp' }),
    ...timestamps,
  },
  (t) => [index('ops_events_notified_at_idx').on(t.notifiedAt)],
)

// Type exports — use these in your app, not raw Drizzle types
export type OpsEvent = typeof opsEvents.$inferSelect
export type NewOpsEvent = typeof opsEvents.$inferInsert
