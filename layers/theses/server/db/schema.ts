// The theses layer's tables: each claim's readings, its status changes and the
// judge's verdicts on its candidate events. NuxtHub merges this file with every
// layer's; the app's server/db/schema.ts re-exports it so the typed `db` and
// drizzle-kit see it.

export * from './tables/theses'
