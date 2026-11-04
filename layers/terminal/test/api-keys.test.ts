import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import sourcesYaml from '~~/sources.yaml?raw'
import * as schema from '~~/server/db/schema'
import { HISTORY_LICENSE, PAID_LICENSE, licenseSplit } from '~~/shared/utils/license'
import {
  API_KEY_PREFIX,
  expiryAfter,
  generateApiKey,
  generateApiKeyId,
  hashApiKey,
  isApiKeyShape,
  keyRefusal,
} from '../server/utils/api-key-token'
import {
  USAGE_FLUSH_MS,
  USAGE_PREFIX,
  createUsageCounter,
  usageOn,
  type UsageStore,
} from '../server/utils/api-key-usage'
import {
  KEY_REFUSALS,
  clearApiKeyCacheForTest,
  collectApiKeyCounters,
  verifyApiKey,
} from '../server/utils/api-keys'
import { paidLicensed, withSchemaVersion } from '../server/utils/terminal-envelope'
import { payloadRefusal, sourceRights, isSnapshotId } from '../server/utils/terminal-payloads'
import { readSourceRegistry } from '../server/utils/terminal-sources'
import { SCHEMA_VERSION } from '../server/utils/data-schema'

// Licensee keys: the token, the lookup and its four refusals, the usage
// counter, and what a key may and may not change.

const db = drizzle(env.DB, { schema })
const NOW = new Date('2026-11-04T12:00:00.000Z')

async function issue(tier: 'research' | 'systematic', overrides: Partial<schema.ApiKeyRow> = {}) {
  const token = generateApiKey()
  const id = generateApiKeyId()
  await db.insert(schema.apiKeys).values({
    id,
    key_hash: await hashApiKey(token),
    client: `Client ${id}`,
    tier,
    issued_at: NOW.toISOString(),
    expires_at: expiryAfter(NOW, 12),
    revoked: false,
    revoked_at: null,
    ...overrides,
  })
  return { token, id }
}

function memoryStore(): UsageStore & { data: Map<string, { value: unknown; metadata: unknown }> } {
  const data = new Map<string, { value: unknown; metadata: unknown }>()
  return {
    data,
    async set(key, value, opts) {
      data.set(key, { value, metadata: opts?.metadata })
    },
    async getKeys(base) {
      return [...data.keys()].filter((k) => k.startsWith(base))
    },
    async get(key) {
      return data.get(key)?.value ?? null
    },
  }
}

beforeEach(() => clearApiKeyCacheForTest())

describe('the key itself', () => {
  it('is an opaque prefixed token, stored only as its SHA-256', async () => {
    const token = generateApiKey()
    expect(token.startsWith(API_KEY_PREFIX)).toBe(true)
    expect(isApiKeyShape(token)).toBe(true)
    expect(generateApiKey()).not.toBe(token)
    expect(await hashApiKey(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(isApiKeyShape(`${token}x`)).toBe(false)
    expect(generateApiKeyId()).toMatch(/^key_[0-9a-f]{10}$/)
  })

  it('expires on the same day of the month, months later', () => {
    expect(expiryAfter(NOW, 12)).toBe('2027-11-04T12:00:00.000Z')
    expect(keyRefusal({ revoked: false, expires_at: '2026-11-04T12:00:00.000Z' }, NOW)).toBe(
      'expired',
    )
    expect(keyRefusal({ revoked: true, expires_at: '2027-01-01T00:00:00Z' }, NOW)).toBe('revoked')
    expect(keyRefusal({ revoked: false, expires_at: '2027-01-01T00:00:00Z' }, NOW)).toBeNull()
  })
})

describe('verifyApiKey', () => {
  it('treats no header as anonymous, and any bad key as a refusal', async () => {
    expect(await verifyApiKey(db, undefined, NOW)).toEqual({ kind: 'anonymous' })
    expect(await verifyApiKey(db, '', NOW)).toEqual({ kind: 'anonymous' })
    expect(await verifyApiKey(db, 'Basic dXNlcjpwYXNz', NOW)).toEqual({
      kind: 'invalid',
      reason: 'malformed',
    })
    expect(await verifyApiKey(db, 'Bearer not-a-key', NOW)).toEqual({
      kind: 'invalid',
      reason: 'malformed',
    })
    expect(await verifyApiKey(db, `Bearer ${generateApiKey()}`, NOW)).toEqual({
      kind: 'invalid',
      reason: 'unknown',
    })
    for (const reason of Object.keys(KEY_REFUSALS)) {
      expect(KEY_REFUSALS[reason as keyof typeof KEY_REFUSALS].length).toBeGreaterThan(10)
    }
  })

  it('accepts a live key, whatever the scheme’s case', async () => {
    const { token, id } = await issue('systematic')
    const verdict = await verifyApiKey(db, `bearer ${token}`, NOW)
    expect(verdict).toEqual({
      kind: 'key',
      key: {
        id,
        client: `Client ${id}`,
        tier: 'systematic',
        expires_at: '2027-11-04T12:00:00.000Z',
      },
    })
  })

  it('refuses an expired key and a revoked one', async () => {
    const expired = await issue('research', { expires_at: '2026-11-01T00:00:00.000Z' })
    expect(await verifyApiKey(db, `Bearer ${expired.token}`, NOW)).toEqual({
      kind: 'invalid',
      reason: 'expired',
    })
    const revoked = await issue('research', { revoked: true, revoked_at: NOW.toISOString() })
    expect(await verifyApiKey(db, `Bearer ${revoked.token}`, NOW)).toEqual({
      kind: 'invalid',
      reason: 'revoked',
    })
  })

  it('sees a revocation once the per-isolate cache entry is a minute old', async () => {
    const { token, id } = await issue('research')
    expect((await verifyApiKey(db, `Bearer ${token}`, NOW)).kind).toBe('key')
    await db.update(schema.apiKeys).set({ revoked: true }).where(eq(schema.apiKeys.id, id))
    expect((await verifyApiKey(db, `Bearer ${token}`, NOW)).kind).toBe('key')
    const later = new Date(NOW.getTime() + 61_000)
    expect(await verifyApiKey(db, `Bearer ${token}`, later)).toEqual({
      kind: 'invalid',
      reason: 'revoked',
    })
  })
})

describe('usage counting', () => {
  it('writes each isolate’s running total to its own shard, at most every flush interval', async () => {
    const store = memoryStore()
    const a = createUsageCounter('aaaa')
    const b = createUsageCounter('bbbb')
    expect(a.due(NOW)).toBe(false)
    a.count('key_1', NOW)
    expect(a.due(NOW)).toBe(true)
    await a.flush(store, NOW)
    a.count('key_1', NOW)
    a.count('key_1', NOW)
    expect(a.due(new Date(NOW.getTime() + 1_000))).toBe(false)
    const later = new Date(NOW.getTime() + USAGE_FLUSH_MS)
    expect(a.due(later)).toBe(true)
    await a.flush(store, later)
    b.count('key_1', NOW)
    b.count('key_2', NOW)
    await b.flush(store, NOW)

    expect(store.data.get(`${USAGE_PREFIX}:2026-11-04:key_1:aaaa`)).toEqual({
      value: 3,
      metadata: { n: 3 },
    })
    expect(await usageOn(store, '2026-11-04')).toEqual(
      new Map([
        ['key_1', 4],
        ['key_2', 1],
      ]),
    )
    expect(await usageOn(store, '2026-11-05')).toEqual(new Map())
  })

  it('starts a new shard at the UTC day boundary', async () => {
    const store = memoryStore()
    const c = createUsageCounter('cccc')
    c.count('key_1', new Date('2026-11-04T23:59:59Z'))
    c.count('key_1', new Date('2026-11-05T00:00:01Z'))
    await c.flush(store, new Date('2026-11-05T00:00:01Z'))
    expect((await usageOn(store, '2026-11-04')).get('key_1')).toBe(1)
    expect((await usageOn(store, '2026-11-05')).get('key_1')).toBe(1)
  })

  it('reports live keys and today’s requests to /api/fleet as counts only', async () => {
    const store = memoryStore()
    const counter = createUsageCounter('dddd')
    counter.count('key_x', NOW)
    counter.count('key_y', NOW)
    await counter.flush(store, NOW)
    const counters = await collectApiKeyCounters(db, store, NOW)
    expect(Object.keys(counters).sort()).toEqual(['apiKeyRequestsToday', 'apiKeysLive'])
    expect(counters.apiKeyRequestsToday).toBe(2)
    expect(counters.apiKeysLive).toBeGreaterThan(0)
  })
})

describe('what a key changes', () => {
  it('relabels the history license, and nothing else in the payload', () => {
    const payload = withSchemaVersion({
      rows: [{ price: 1 }],
      license: licenseSplit(NOW),
      point_in_time: { requested: '2026-01-01T00:00:00Z', license: HISTORY_LICENSE.id },
    })
    expect(Object.keys(payload)[0]).toBe('schema_version')
    expect((payload as { schema_version?: string }).schema_version).toBe(SCHEMA_VERSION)
    const keyed = paidLicensed(payload, NOW)
    expect(keyed.rows).toBe(payload.rows)
    expect((keyed as { schema_version?: string }).schema_version).toBe(SCHEMA_VERSION)
    expect(keyed.license.older.id).toBe(PAID_LICENSE.id)
    expect(keyed.license.recent).toEqual(payload.license.recent)
    expect(keyed.point_in_time.license).toBe(PAID_LICENSE.id)
    expect(paidLicensed({ point_in_time: { license: 'CC-BY-4.0' } }).point_in_time.license).toBe(
      'CC-BY-4.0',
    )
  })

  it('serves saved pages only for sources that are ours to license', () => {
    const registry = readSourceRegistry(sourcesYaml)
    const ours = registry.sources.find((s) => s.rights === 'ours')!
    const notCleared = registry.sources.find((s) => s.rights === 'not-cleared')!
    expect(payloadRefusal(sourceRights(registry, ours.source_id))).toBeNull()
    expect(payloadRefusal(sourceRights(registry, notCleared.source_id))).toMatch(/isn’t cleared/)
    expect(payloadRefusal('upstream')).toMatch(/own license/)
    expect(payloadRefusal(sourceRights(registry, 'no-such-source'))).toMatch(/no rights/)
    // A derived source takes its parent's rights.
    const parent = registry.sources.find((s) => s.yaml_id === 'openai-models-md')!
    expect(sourceRights(registry, 'openai-model-md-gpt-5')).toBe(parent.rights)
  })

  it('takes a snapshot id as the snapshots export prints it', () => {
    expect(isSnapshotId('openai-status:2026-10-12T18:11:06.839Z')).toBe(true)
    expect(isSnapshotId('edgar-submissions-spcx:2026-10-12T18:11:06Z')).toBe(true)
    expect(isSnapshotId('../../etc/passwd')).toBe(false)
    expect(isSnapshotId('openai-status')).toBe(false)
  })
})
