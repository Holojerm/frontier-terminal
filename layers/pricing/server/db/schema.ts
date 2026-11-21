// The pricing layer's tables: the judge's class-map decisions and price-list
// reads, and the archived price lists and rate limits. NuxtHub merges this
// file with every layer's; the app's server/db/schema.ts re-exports it so the
// typed `db` and drizzle-kit see it. Each table imports core's columns by
// relative path, since neither bundler resolves `#layers` aliases.

export * from './tables/judge'
export * from './tables/archive'
