// The talent layer's tables: the archived job boards and the listed
// companies' hiring. The labs' live roles are entities in core's store. NuxtHub
// merges this file with every layer's; the app's server/db/schema.ts
// re-exports it so the typed `db` and drizzle-kit see it. Each table imports
// core's columns by relative path, since neither bundler resolves `#layers`
// aliases.

export * from './tables/archive'
export * from './tables/listed-hiring'
