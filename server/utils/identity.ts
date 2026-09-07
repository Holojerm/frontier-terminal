// The one salt that must never change.
//
// A per-deployment salt for hashing values that must be recognisable later
// without being readable now (an IP for a rate limit, a key for a dedupe
// check). It is generated once and stored in `instance_secrets` rather than
// read from an env var, because an env var is a setup step every fork would
// have to remember and the fork that forgets gets a silently different hash on
// every deploy. A value generated once and kept makes the DEFAULT correct
// rather than the documented path correct — the same trade the design and SEO
// gates in this repo make everywhere else.
//
// So: 32 random bytes, written once, read forever. No configuration, no
// rotation story, and nothing for a fork to get wrong.

import { eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'

import * as tables from '../db/schema'
import { base64url } from './hash'

export type IdentityDb = ReturnType<typeof drizzle<typeof tables>>

/** The row id. Chosen here, in code — never from a request (see schema.ts). */
export const IDENTITY_SALT_ID = 'identity-salt'

/**
 * Memoised per isolate. The value is immutable by construction, so there is no
 * invalidation to get wrong.
 */
let cached: string | null = null

/**
 * The deployment's identity salt, generating it on first use.
 *
 * ── Race safety, which is the only interesting part ──────────────────────────
 * Two requests can reach a virgin database at the same moment, and if both
 * generated a salt and both kept their own, two values would be hashed under
 * different salts — the exact invariant break this salt exists to prevent, on
 * day one, permanently.
 *
 * `INSERT … ON CONFLICT DO NOTHING` followed by a read makes that impossible
 * without a transaction: both writers race, the primary key lets exactly one
 * win, and both then read the winner's value. The loser's random bytes are
 * discarded before anything is derived from them.
 */
export async function getIdentitySalt(db: IdentityDb): Promise<string> {
  if (cached) return cached

  const existing = await db.query.instanceSecrets.findFirst({
    where: eq(tables.instanceSecrets.id, IDENTITY_SALT_ID),
    columns: { value: true },
  })
  if (existing?.value) {
    cached = existing.value
    return cached
  }

  // 32 bytes — the same budget as a session key. base64url so the value is
  // printable if somebody ever has to look at it in a database console.
  const candidate = base64url(crypto.getRandomValues(new Uint8Array(32)))
  await db
    .insert(tables.instanceSecrets)
    .values({ id: IDENTITY_SALT_ID, value: candidate })
    .onConflictDoNothing({ target: tables.instanceSecrets.id })

  // Read back rather than trusting `candidate`: on the losing side of a race
  // the insert did nothing, and the row now holds somebody else's bytes.
  const stored = await db.query.instanceSecrets.findFirst({
    where: eq(tables.instanceSecrets.id, IDENTITY_SALT_ID),
    columns: { value: true },
  })
  if (!stored?.value) {
    // Practically unreachable — the insert either wrote a row or lost to one.
    throw new Error('identity salt could not be provisioned')
  }

  cached = stored.value
  return cached
}

/** Drop the memo. Tests only — production has nothing that should call this. */
export function resetIdentitySaltCache(): void {
  cached = null
}
