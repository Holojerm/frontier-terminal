// The compute layer's tables: who powers each lab site, the grid load around
// them, and the hardware prints. NuxtHub merges this file with every layer's;
// the app's server/db/schema.ts re-exports it so the typed `db` and
// drizzle-kit see it. Each table imports core's columns by relative path,
// since neither bundler resolves `#layers` aliases.

export * from './tables/power-sites'
export * from './tables/grid-load'
export * from './tables/prints'
