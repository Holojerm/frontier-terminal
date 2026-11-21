import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Alert webhooks, configured by the owner with `bun run webhooks:add`. Each
// belongs to one API key and stops when that key is revoked or expires. No
// secret is stored: the signing secret is derived from the Worker secret
// NUXT_WEBHOOK_SIGNING_KEY and the webhook id (layers/alerts/server/utils/webhook-sign.ts).
// secret_hash is the SHA-256 of that secret, a fingerprint for webhooks:list.
// signing_key_id names the Worker secret the secret came from, so a rotated
// key fails loudly instead of signing with a secret the client doesn't hold.
export const webhooks = sqliteTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    api_key_id: text('api_key_id').notNull(),
    url: text('url').notNull(),
    min_severity: text('min_severity').notNull(), // info | notable | critical
    secret_hash: text('secret_hash').notNull(),
    signing_key_id: text('signing_key_id').notNull(),
    status: text('status').notNull().default('active'), // active | failing | removed
    created_at: text('created_at').notNull(),
    failing_since: text('failing_since'),
    last_error: text('last_error'),
    removed_at: text('removed_at'),
  },
  (t) => [index('webhooks_api_key_idx').on(t.api_key_id)],
)

// The webhook outbox: one row per (alert, webhook), unique, so enqueueing is
// idempotent. id is the X-Frontier-Delivery header, the same on every retry.
export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    webhook_id: text('webhook_id').notNull(),
    alert_id: text('alert_id').notNull(),
    // queued | delivered | failed | expired | cancelled | suppressed
    status: text('status').notNull().default('queued'),
    // When the alert was written (alerts.recorded_at): not sent until the
    // public site's stamp is past it.
    seen_at: text('seen_at').notNull(),
    // Not sent before this: when it was queued, or a judged alert's hold.
    not_before: text('not_before').notNull(),
    next_attempt_at: text('next_attempt_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    last_attempt_at: text('last_attempt_at'),
    last_status: integer('last_status'),
    last_error: text('last_error'),
    delivered_at: text('delivered_at'),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_alert_webhook_idx').on(t.alert_id, t.webhook_id),
    index('webhook_deliveries_status_next_idx').on(t.status, t.next_attempt_at),
    index('webhook_deliveries_webhook_idx').on(t.webhook_id, t.status),
  ],
)

export type WebhookRow = typeof webhooks.$inferSelect

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect
