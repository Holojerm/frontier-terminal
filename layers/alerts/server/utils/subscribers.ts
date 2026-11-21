// Subscriber state: the double opt-in, the unsubscribe token, and which
// confirmed rows get this week's digest. Every function takes the db and the
// time, so the workerd tests drive them without booting Nitro.

import { and, count, eq, inArray, isNull, lt, or } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { ExtensionDb } from '#server/utils/extensions'
import { base64url, sha256Hex, timingSafeEqual } from '#server/utils/hash'

import { cleanFromPath } from '../../shared/utils/subscribe'

/** A confirmation link works for a week; a pending row is deleted after a month. */
export const CONFIRM_TTL_DAYS = 7
export const PENDING_PURGE_DAYS = 30
/** Asking again within this window sends no second confirmation mail. */
export const RESEND_COOLDOWN_MINUTES = 10
/** A row that got a digest this recently is skipped, so a re-run never doubles a send. */
export const DIGEST_MIN_GAP_DAYS = 6

const daysAgo = (now: Date, days: number): string =>
  new Date(now.getTime() - days * 86_400_000).toISOString()

export const newToken = (): string => base64url(crypto.getRandomValues(new Uint8Array(24)))

/**
 * Records a request to subscribe. Returns the confirmation token to mail, or
 * null when no mail should go out (already confirmed, or asked a moment ago).
 * The caller answers the same either way.
 */
export async function requestSubscription(
  db: ExtensionDb,
  input: { email: string; from?: string | undefined },
  now: Date,
): Promise<{ token: string } | null> {
  const stamp = now.toISOString()
  const existing = await db.query.subscribers.findFirst({
    where: eq(tables.subscribers.email, input.email),
  })
  if (existing?.status === 'confirmed') return null
  if (
    existing?.status === 'pending' &&
    existing.confirm_sent_at &&
    existing.confirm_sent_at >
      new Date(now.getTime() - RESEND_COOLDOWN_MINUTES * 60_000).toISOString()
  ) {
    return null
  }

  const token = newToken()
  const hash = await sha256Hex(token)
  if (existing) {
    await db
      .update(tables.subscribers)
      .set({ status: 'pending', confirm_token_hash: hash, confirm_sent_at: stamp })
      .where(eq(tables.subscribers.id, existing.id))
    return { token }
  }
  const inserted = await db
    .insert(tables.subscribers)
    .values({
      email: input.email,
      status: 'pending',
      confirm_token_hash: hash,
      confirm_sent_at: stamp,
      subscribed_from: cleanFromPath(input.from),
      created_at: stamp,
    })
    .onConflictDoNothing({ target: tables.subscribers.email })
    .returning({ id: tables.subscribers.id })
  // Lost a race with a second request for the same address: that one mails.
  return inserted.length > 0 ? { token } : null
}

/** Confirms the row a token belongs to. Repeating the click is harmless. */
export async function confirmSubscription(
  db: ExtensionDb,
  token: string,
  now: Date,
): Promise<'confirmed' | 'invalid'> {
  const row = await db.query.subscribers.findFirst({
    where: eq(tables.subscribers.confirm_token_hash, await sha256Hex(token)),
  })
  if (!row) return 'invalid'
  if (row.status === 'confirmed') return 'confirmed'
  if (row.status !== 'pending') return 'invalid'
  if (!row.confirm_sent_at || row.confirm_sent_at < daysAgo(now, CONFIRM_TTL_DAYS)) return 'invalid'
  await db
    .update(tables.subscribers)
    .set({ status: 'confirmed', confirmed_at: now.toISOString() })
    .where(eq(tables.subscribers.id, row.id))
  return 'confirmed'
}

async function sign(secret: string, id: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`subscriber-unsubscribe:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return base64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id)))
}

/** `<id>.<signature>`: stateless, so every digest can carry one and none expires. */
export async function unsubscribeToken(secret: string, id: string): Promise<string> {
  return `${id}.${await sign(secret, id)}`
}

export async function unsubscribe(
  db: ExtensionDb,
  secret: string,
  token: string,
  now: Date,
): Promise<'unsubscribed' | 'invalid'> {
  const dot = token.lastIndexOf('.')
  if (dot < 1) return 'invalid'
  const id = token.slice(0, dot)
  if (!timingSafeEqual(token.slice(dot + 1), await sign(secret, id))) return 'invalid'
  await db
    .update(tables.subscribers)
    .set({ status: 'unsubscribed', unsubscribed_at: now.toISOString() })
    .where(and(eq(tables.subscribers.id, id), eq(tables.subscribers.status, 'confirmed')))
  return 'unsubscribed'
}

export interface DigestRecipient {
  id: string
  email: string
}

/** Confirmed rows that have not had a digest in the last DIGEST_MIN_GAP_DAYS. */
export async function selectDigestRecipients(
  db: ExtensionDb,
  now: Date,
  limit: number,
): Promise<DigestRecipient[]> {
  return db
    .select({ id: tables.subscribers.id, email: tables.subscribers.email })
    .from(tables.subscribers)
    .where(
      and(
        eq(tables.subscribers.status, 'confirmed'),
        or(
          isNull(tables.subscribers.last_digest_at),
          lt(tables.subscribers.last_digest_at, daysAgo(now, DIGEST_MIN_GAP_DAYS)),
        ),
      ),
    )
    .orderBy(tables.subscribers.id)
    .limit(limit)
}

export async function markDigestSent(db: ExtensionDb, ids: string[], now: Date): Promise<void> {
  if (ids.length === 0) return
  await db
    .update(tables.subscribers)
    .set({ last_digest_at: now.toISOString() })
    .where(inArray(tables.subscribers.id, ids))
}

/** Deletes pending rows that never confirmed. Returns how many. */
export async function purgeStalePending(db: ExtensionDb, now: Date): Promise<number> {
  const gone = await db
    .delete(tables.subscribers)
    .where(
      and(
        eq(tables.subscribers.status, 'pending'),
        lt(tables.subscribers.confirm_sent_at, daysAgo(now, PENDING_PURGE_DAYS)),
      ),
    )
    .returning({ id: tables.subscribers.id })
  return gone.length
}

export async function countConfirmed(db: ExtensionDb): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(tables.subscribers)
    .where(eq(tables.subscribers.status, 'confirmed'))
  return row?.total ?? 0
}
