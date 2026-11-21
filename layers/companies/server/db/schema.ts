// The companies layer's tables: the filed facts, text facts and guidance the
// exposure reader stores, the call documents and their resolutions, and the
// suppliers' documents and passages. NuxtHub merges this file with every
// layer's; the app's server/db/schema.ts re-exports it so the typed `db` and
// drizzle-kit see it.

export * from './tables/filings'
export * from './tables/suppliers'
