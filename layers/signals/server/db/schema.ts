// The signals layer's tables: the licensed daily closes and how far each pull
// has reached, the harness's runs and statistics, and the forward calls with
// their scores. NuxtHub merges this file with every layer's; the app's
// server/db/schema.ts re-exports it so the typed `db` and drizzle-kit see it.

export * from './tables/signals'
