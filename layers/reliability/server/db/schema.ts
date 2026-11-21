// The reliability layer's tables: the latency probes, the feed's own reliability record
// (source runs per day, poll ticks, filing detections, deploy checks) and the archived status
// feeds. The labs' live incidents are entities in core's store. The app's server/db/schema.ts
// re-exports this file so the typed `db` and drizzle-kit see it. Tables import core's columns
// by relative path, since neither bundler resolves `#layers` aliases.

export * from './tables/archive'
export * from './tables/probes'
export * from './tables/reliability'
