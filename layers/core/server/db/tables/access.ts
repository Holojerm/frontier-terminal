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

export type ApiKeyRow = typeof apiKeys.$inferSelect
