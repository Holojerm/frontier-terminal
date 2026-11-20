// The Frontier Terminal tables, one file per domain under ./tables/; add a
// table to its domain's file, or a new file listed here. NuxtHub merges every
// layer's server/db/schema.ts (it globs db/schema/, so the parts live in
// tables/ to keep this file the one entry); the app's server/db/schema.ts
// re-exports this one so core's typed `db` and drizzle-kit see it. Migrations
// stay app-owned, in server/db/migrations. None of these tables references a
// core table, so no import from the app schema is needed.
//
// These break the camelCase convention of the app's schema on purpose: the TypeScript keys
// ARE the zod contract's field names, so a validated contract row is the
// insert value with no mapping layer in between — one fewer place for a
// column to be renamed on one side only. Timestamps are ISO 8601 text with a
// timezone, exactly as the contracts carry them, not epoch integers: the
// stored string is the datum a reader is shown, and converting it twice is a
// chance to lose the offset.

export * from './tables/pipeline'
export * from './tables/judge'
export * from './tables/theses'
export * from './tables/filings'
export * from './tables/track-record'
export * from './tables/reported'
export * from './tables/access'
export * from './tables/archive'
export * from './tables/reliability'
export * from './tables/subscribers'
export * from './tables/probes'
