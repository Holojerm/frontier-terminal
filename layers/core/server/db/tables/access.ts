import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Licensee API keys, issued by the owner with `bun run keys:issue`. Only the
// SHA-256 of a key is stored, so a leaked table grants nothing. Never exported,
// never served: layers/core/server/utils/api-keys.ts reads it by hash.
export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    key_hash: text('key_hash').notNull(),
    client: text('client').notNull(),
    tier: text('tier').notNull(), // research | systematic
    issued_at: text('issued_at').notNull(),
    expires_at: text('expires_at').notNull(),
    revoked: integer('revoked', { mode: 'boolean' }).notNull().default(false),
    revoked_at: text('revoked_at'),
  },
  (t) => [uniqueIndex('api_keys_hash_idx').on(t.key_hash)],
)

// S3 read access to the licensed bulk bucket, granted by the owner with
// `bun run bulk:grant`. Each grant is one Cloudflare API token, read-only and
// scoped to that bucket, expiring with the key it was granted to. token_id is
// the token's id, which is also the S3 access key id; the secret is shown once
// and never stored. Never exported, never served.
export const bulkGrants = sqliteTable(
  'bulk_grants',
  {
    id: text('id').primaryKey(),
    api_key_id: text('api_key_id').notNull(),
    token_id: text('token_id').notNull(),
    bucket: text('bucket').notNull(),
    created_at: text('created_at').notNull(),
    expires_at: text('expires_at').notNull(),
    revoked_at: text('revoked_at'),
    revoke_reason: text('revoke_reason'), // owner | key-revoked | key-expired
  },
  (t) => [
    index('bulk_grants_api_key_idx').on(t.api_key_id),
    uniqueIndex('bulk_grants_token_idx').on(t.token_id),
  ],
)

// Alert webhooks, configured by the owner with `bun run webhooks:add`. Each
// belongs to one API key and stops when that key is revoked or expires. No
// secret is stored: the signing secret is derived from the Worker secret
// NUXT_WEBHOOK_SIGNING_KEY and the webhook id (layers/terminal/server/utils/webhook-sign.ts).
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

export type ApiKeyRow = typeof apiKeys.$inferSelect

export type WebhookRow = typeof webhooks.$inferSelect

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect
