// The companies layer's tables: filed facts, text facts and guidance from the exposure
// reader, call documents and their resolutions, and suppliers' documents and passages.
// The app's server/db/schema.ts re-exports it so the typed `db` and drizzle-kit see it.

export * from './tables/filings'
export * from './tables/suppliers'
