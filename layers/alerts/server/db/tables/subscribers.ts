import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// ─────────────────────────────────────────────
// Digest subscribers
// ─────────────────────────────────────────────
// The only personal data this app stores: an email address someone typed into
// the subscribe form (layers/alerts/server/utils/subscribers.ts). Double
// opt-in: a row is `pending` until its confirmation link is followed. The
// confirm token is stored as a SHA-256 hash, so a database read cannot confirm
// anyone. The unsubscribe token is not stored at all: it is an HMAC of the row
// id under the instance salt, so every digest can carry one without a column.
// An unsubscribed row stays, marked, so the address is not re-added by mistake;
// a `pending` row that never confirms is deleted after 30 days.
export const subscribers = sqliteTable(
  'subscribers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    email: text('email').notNull(), // lowercased
    status: text('status', { enum: ['pending', 'confirmed', 'unsubscribed'] }).notNull(),
    confirm_token_hash: text('confirm_token_hash'),
    confirm_sent_at: text('confirm_sent_at'),
    subscribed_from: text('subscribed_from'), // the page path, query stripped
    created_at: text('created_at').notNull(),
    confirmed_at: text('confirmed_at'),
    unsubscribed_at: text('unsubscribed_at'),
    last_digest_at: text('last_digest_at'),
  },
  (t) => [
    uniqueIndex('subscribers_email_idx').on(t.email),
    index('subscribers_confirm_token_idx').on(t.confirm_token_hash),
    index('subscribers_status_idx').on(t.status),
  ],
)

export type Subscriber = typeof subscribers.$inferSelect
