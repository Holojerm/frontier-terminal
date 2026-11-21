// Requests per key per UTC day, in KV, for `bun run keys:list` and the /api/fleet
// totals. Never public. A shared counter would race and hit KV's one write a
// second per key, so each isolate counts in memory and writes its running total,
// at most once per USAGE_FLUSH_MS, to its own shard
// (`apikey-usage:<YYYY-MM-DD>:<key id>:<isolate>`); a day is the sum of its
// shards. The total is also in each shard's metadata, so one `list` reads a day.
// An isolate evicted between flushes loses its count: fine for usage, not billing.

export const USAGE_PREFIX = 'apikey-usage'
export const USAGE_FLUSH_MS = 30_000
/** Long enough to show the trailing month in keys:list. */
export const USAGE_TTL_SECONDS = 40 * 86_400

/** The slice of unstorage the counter writes and reads, so tests pass a Map-backed fake. */
export interface UsageStore {
  set(key: string, value: unknown, opts?: { ttl?: number; metadata?: unknown }): Promise<unknown>
  getKeys(base: string): Promise<string[]>
  get(key: string): Promise<unknown>
}

export const usageDay = (now: Date): string => now.toISOString().slice(0, 10)

export interface UsageCounter {
  count(keyId: string, now: Date): void
  /** True when a flush is owed: something counted, and the last flush is USAGE_FLUSH_MS old. */
  due(now: Date): boolean
  flush(store: UsageStore, now: Date): Promise<void>
}

export function createUsageCounter(
  isolate: string = crypto.randomUUID().slice(0, 8),
): UsageCounter {
  /** `<day>:<key id>` → this isolate's total for that day. */
  const totals = new Map<string, number>()
  const dirty = new Set<string>()
  let lastFlush = Number.NEGATIVE_INFINITY

  return {
    count(keyId, now) {
      const shard = `${usageDay(now)}:${keyId}`
      totals.set(shard, (totals.get(shard) ?? 0) + 1)
      dirty.add(shard)
    },
    due(now) {
      return dirty.size > 0 && now.getTime() - lastFlush >= USAGE_FLUSH_MS
    },
    async flush(store, now) {
      lastFlush = now.getTime()
      const writes = [...dirty].map((shard) => {
        const n = totals.get(shard) ?? 0
        return store.set(`${USAGE_PREFIX}:${shard}:${isolate}`, n, {
          ttl: USAGE_TTL_SECONDS,
          metadata: { n },
        })
      })
      dirty.clear()
      // A finished day can't change again in this isolate.
      const today = usageDay(now)
      for (const shard of totals.keys()) if (shard.slice(0, 10) < today) totals.delete(shard)
      await Promise.all(writes)
    },
  }
}

/** Requests per key id on `day`, summed over its shards. */
export async function usageOn(store: UsageStore, day: string): Promise<Map<string, number>> {
  const keys = await store.getKeys(`${USAGE_PREFIX}:${day}`)
  const values = await Promise.all(keys.map((key) => store.get(key)))
  const out = new Map<string, number>()
  keys.forEach((key, i) => {
    const keyId = key.split(':')[2]
    const n = Number(values[i])
    if (keyId && Number.isFinite(n)) out.set(keyId, (out.get(keyId) ?? 0) + n)
  })
  return out
}
