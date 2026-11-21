import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from '../../../../core/server/db/tables/columns'

// What the judge decides and reads about the price lists: the class map's
// re-mappings and the price lists it read while their parser was failing.

// Class-map decisions — append-only. One row per mapping the judge changed on
// the like-for-like price matrix (layers/pricing/server/pipeline/judge/class-map.ts). The
// hand-transcribed MODEL_CLASS_MAP (layers/pricing/server/utils/terminal-classes.ts) is the
// seed; the newest row per (provider, class) overrides it. A row is written
// only after the Worker proved the sentence is on the vendor page, so its
// provenance is the snapshot that sentence was verified in, not the judge.
export const classMapDecisions = sqliteTable(
  'class_map_decisions',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    class: text('class').notNull(),
    model_slug: text('model_slug').notNull(),
    basis: text('basis').notNull(),
    basis_source_id: text('basis_source_id').notNull(),
    decided_at: text('decided_at').notNull(),
    decided_by: text('decided_by').notNull(), // 'judge' today; anything else that decides says who
    ...provenance,
  },
  (t) => [
    index('class_map_decisions_cell_idx').on(t.provider, t.class, t.decided_at),
    // terminalStamps() reads max(decided_at) on every cached request; the cell index can't serve it.
    index('class_map_decisions_decided_idx').on(t.decided_at),
  ],
)

// One row per page of a price list the judge read while its parser was
// failing (layers/pricing/server/pipeline/judge/price-review.ts). `readings`
// holds, for each SKU whose price changed, the run of the page it was read
// from; the row also marks the page as read, so it is offered once.
export const priceReadings = sqliteTable(
  'price_readings',
  {
    id: text('id').primaryKey(),
    source_id: text('source_id').notNull(),
    snapshot_id: text('snapshot_id').notNull(),
    content_hash: text('content_hash').notNull(),
    confirmed: integer('confirmed').notNull(),
    changed: integer('changed').notNull(),
    readings: text('readings').notNull(), // JSON
    source_url: text('source_url').notNull(),
    fetched_at: text('fetched_at').notNull(),
    read_at: text('read_at').notNull(),
  },
  (t) => [index('price_readings_source_idx').on(t.source_id, t.read_at)],
)

export type ClassMapDecision = typeof classMapDecisions.$inferSelect
