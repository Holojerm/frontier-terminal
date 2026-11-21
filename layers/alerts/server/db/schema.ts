// The alerts layer's tables: the digest subscribers, and the alert webhooks
// with their delivery outbox. NuxtHub merges this file with every layer's; the
// app's server/db/schema.ts re-exports it so the typed `db` and drizzle-kit
// see it. The alerts themselves (alerts, alert_cites) are core's, because the
// store writes them on every tick.

export * from './tables/subscribers'
export * from './tables/webhooks'
