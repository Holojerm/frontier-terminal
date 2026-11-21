import { index, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { provenance } from '../../../../core/server/db/tables/columns'

// ─────────────────────────────────────────────
// Archived GPU prices (layers/compute/server/pipeline/archive/)
// ─────────────────────────────────────────────
// Each row names its capture in archive_captures (layers/core/server/db/tables/archive.ts).

// One row per (capture, priced row) of an archived GPU price page, keyed like the
// live recipe (gpu-prices.ts › gpuObservations). basis is always 'archived': nothing
// here reaches the GPU median floor, the Compute thesis, the judge or the alerts.
export const archivedGpuPrices = sqliteTable(
  'archived_gpu_prices',
  {
    id: text('id').primaryKey(),
    capture_id: text('capture_id').notNull(),
    provider: text('provider').notNull(),
    key: text('key').notNull(),
    gpu: text('gpu').notNull(), // H100 | B200
    value: real('value').notNull(),
    payload: text('payload').notNull(),
    captured_at: text('captured_at').notNull(),
    original_url: text('original_url').notNull(),
    basis: text('basis').notNull(), // 'archived'
    ...provenance,
  },
  (t) => [
    index('archived_gpu_prices_provider_idx').on(t.provider, t.gpu, t.captured_at),
    index('archived_gpu_prices_captured_id_idx').on(t.captured_at, t.id),
  ],
)
