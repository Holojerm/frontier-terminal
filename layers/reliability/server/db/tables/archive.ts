import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from '../../../../core/server/db/tables/columns'

// Status-page incidents from before this site watched the labs, read from the
// Internet Archive's captures of each lab's own status feed. Each row names its
// capture in archive_captures (layers/core/server/db/tables/archive.ts),
// which logs the captures of every archived axis.

// One row per incident an archived status feed listed, however many copies
// listed it: the id is <provider>:<incident id>, the feed's own id. Each field
// is the newest copy's (capture_id, captured_at, source_url say which copy);
// first_captured_at is the oldest copy that listed it. The fields are the
// live IncidentRow's, so impact is null where the feed publishes none. Never a
// live row: basis is always 'archived', and nothing here reaches entities,
// changes, the incident windows, the alerts or the judge.
export const archivedIncidents = sqliteTable(
  'archived_incidents',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    incident_id: text('incident_id').notNull(),
    title: text('title').notNull(),
    impact: text('impact'),
    status: text('status').notNull(),
    started_at: text('started_at').notNull(),
    resolved_at: text('resolved_at'),
    components: text('components').notNull(), // JSON array, sorted
    incident_url: text('incident_url').notNull(),
    capture_id: text('capture_id').notNull(),
    captured_at: text('captured_at').notNull(),
    first_captured_at: text('first_captured_at').notNull(),
    original_url: text('original_url').notNull(),
    basis: text('basis').notNull(), // 'archived'
    ...provenance,
  },
  (t) => [
    index('archived_incidents_provider_idx').on(t.provider, t.started_at),
    index('archived_incidents_captured_id_idx').on(t.captured_at, t.id),
  ],
)

export type ArchivedIncidentRow = typeof archivedIncidents.$inferSelect
