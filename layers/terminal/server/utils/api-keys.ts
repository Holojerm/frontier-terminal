// Who is asking: anonymous, a valid licensee key, or a key that must be refused.
//
// A request with no Authorization header is anonymous and is served exactly as
// before. A request that presents one is either a live key or a 401: a wrong,
// expired, or revoked key never falls back to anonymous, because a licensee
// whose key lapsed should find out from the status code, not from a rate limit
// or a licence field an hour later.
//
// Pure functions of the Drizzle client, so layers/terminal/test/api-keys.test.ts
// drives them against the workerd D1.

import { and, count, eq, gt } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../pipeline/store'
import {
  hashApiKey,
  isApiKeyShape,
  isApiKeyTier,
  keyRefusal,
  type ApiKeyTier,
} from './api-key-token'
import { usageDay, usageOn, type UsageStore } from './api-key-usage'

export interface ApiKey {
  id: string
  client: string
  tier: ApiKeyTier
  expires_at: string
}

export type ApiKeyVerdict =
  | { kind: 'anonymous' }
  | { kind: 'key'; key: ApiKey }
  | { kind: 'invalid'; reason: 'malformed' | 'unknown' | 'expired' | 'revoked' }

export const KEY_REFUSALS: Readonly<
  Record<Extract<ApiKeyVerdict, { kind: 'invalid' }>['reason'], string>
> = {
  malformed: 'The Authorization header must be "Bearer <key>" with a Frontier Terminal API key.',
  unknown: 'This API key isn’t recognised.',
  expired: 'This API key has expired. Email contact@frontierterm.com to renew it.',
  revoked: 'This API key has been revoked.',
}

interface Stored {
  row: (ApiKey & { revoked: boolean }) | null
  at: number
}

/**
 * Lookups by hash, per isolate, for a minute: a licensee syncing at 20
 * requests a second should not cost 20 D1 reads a second. A revocation takes
 * effect within CACHE_MS. Unknown hashes are cached too, so a spray of made-up
 * keys reads D1 once per key per minute, and the map is cleared when it grows
 * past CACHE_MAX rather than evicted entry by entry.
 */
const CACHE_MS = 60_000
const CACHE_MAX = 1_000
const cache = new Map<string, Stored>()

/** Test-only. */
export function clearApiKeyCacheForTest(): void {
  cache.clear()
}

async function lookup(db: PipelineDb, hash: string, now: number): Promise<Stored['row']> {
  const hit = cache.get(hash)
  if (hit && now - hit.at < CACHE_MS) return hit.row
  const [found] = await db
    .select()
    .from(tables.apiKeys)
    .where(eq(tables.apiKeys.key_hash, hash))
    .limit(1)
  const row =
    found && isApiKeyTier(found.tier)
      ? {
          id: found.id,
          client: found.client,
          tier: found.tier,
          expires_at: found.expires_at,
          revoked: found.revoked,
        }
      : null
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(hash, { row, at: now })
  return row
}

/** The verdict for an Authorization header. Absent or empty is anonymous. */
export async function verifyApiKey(
  db: PipelineDb,
  authorization: string | null | undefined,
  now: Date = new Date(),
): Promise<ApiKeyVerdict> {
  if (authorization === undefined || authorization === null || authorization.trim() === '') {
    return { kind: 'anonymous' }
  }
  const token = /^\s*Bearer\s+(\S+)\s*$/i.exec(authorization)?.[1]
  if (!token || !isApiKeyShape(token)) return { kind: 'invalid', reason: 'malformed' }

  const row = await lookup(db, await hashApiKey(token), now.getTime())
  if (!row) return { kind: 'invalid', reason: 'unknown' }
  const refusal = keyRefusal(row, now)
  if (refusal) return { kind: 'invalid', reason: refusal }
  return {
    kind: 'key',
    key: { id: row.id, client: row.client, tier: row.tier, expires_at: row.expires_at },
  }
}

/**
 * GET /api/fleet's licensee numbers: live keys, and requests across all keys
 * today. Counts only, like every fleet counter. Who used what is
 * `bun run keys:list`.
 */
export async function collectApiKeyCounters(
  db: PipelineDb,
  usage: UsageStore,
  now: Date,
): Promise<Record<string, number>> {
  const [live] = await db
    .select({ n: count() })
    .from(tables.apiKeys)
    .where(and(eq(tables.apiKeys.revoked, false), gt(tables.apiKeys.expires_at, now.toISOString())))
  const today = await usageOn(usage, usageDay(now))
  return {
    apiKeysLive: live?.n ?? 0,
    apiKeyRequestsToday: [...today.values()].reduce((a, b) => a + b, 0),
  }
}
