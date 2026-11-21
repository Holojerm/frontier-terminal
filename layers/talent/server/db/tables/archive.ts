import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from '../../../../core/server/db/tables/columns'

// Job boards from before this site watched the labs, read from the Internet
// Archive's captures of each lab's own board. Each row names its capture in
// archive_captures (layers/terminal/server/db/tables/archive.ts), which logs
// the captures of every archived axis.

// One row per (capture, count): what an archived job board listed. Each
// parsed capture writes one `board` row (open roles on the whole board) and,
// when the capture lists every role with its department, one `department`
// row per department, summing to the board row. `label` is the department as
// the board printed it then; `department` is the live department it files
// under (layers/talent/server/pipeline/archive/hiring-eras.ts › liveDepartment), the label itself unless
// the board's own id ties it to a live one. Counts only: no role, title or
// person is stored. Never a live row: basis is always 'archived', and
// nothing here reaches the hiring floor, the roll-up, the judge or a thesis.
export const archivedHiring = sqliteTable(
  'archived_hiring',
  {
    id: text('id').primaryKey(),
    capture_id: text('capture_id').notNull(),
    provider: text('provider').notNull(),
    scope: text('scope').notNull(), // board | department
    label: text('label'),
    department_id: text('department_id'),
    department: text('department'),
    open_roles: integer('open_roles').notNull(),
    captured_at: text('captured_at').notNull(),
    original_url: text('original_url').notNull(),
    basis: text('basis').notNull(), // 'archived'
    ...provenance,
  },
  (t) => [
    index('archived_hiring_provider_idx').on(t.provider, t.scope, t.captured_at),
    index('archived_hiring_captured_id_idx').on(t.captured_at, t.id),
  ],
)

export type ArchivedHiringRow = typeof archivedHiring.$inferSelect
