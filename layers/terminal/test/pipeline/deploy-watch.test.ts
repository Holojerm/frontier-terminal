import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import {
  checkDeployDrift,
  DRIFT_RENOTIFY_MS,
  driftMarkerKey,
  fetchMainHead,
  parseRefAdvertisement,
} from '../../server/pipeline/deploy-watch'
import type { LockStore } from '../../server/pipeline/lock'

// The 2026-11-03 incident: #117 merged at 16:43, its build timed out before
// starting, and production stayed on c2aa4d1 until a manual retry at 23:42.

const db = drizzle(env.DB, { schema })
const DEPLOYED = 'c2aa4d101fdc3e2e5375a3eb33e8ec5b1c656a32'
const HEAD = '188fab3f94a7ad466729a472c8d1359a30f98b96'
const at = (hhmm: string) => new Date(`2026-11-03T${hhmm}:00Z`)

// Shape of GitHub's real answer, trimmed: pkt-line lengths, HEAD with its
// capability list after a NUL, then one line per ref.
const ADVERTISEMENT =
  '001e# service=git-upload-pack\n0000' +
  `0159${HEAD} HEAD\0multi_ack thin-pack symref=HEAD:refs/heads/main agent=git/github\n` +
  `003f${'a'.repeat(40)} refs/heads/feat/other\n` +
  `003d${HEAD} refs/heads/main\n0000`

function memoryMarker(): LockStore & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
  }
}

const driftEvents = async () =>
  (await db.select().from(schema.opsEvents)).filter((r) => r.kind === 'deploy_drift')

beforeEach(async () => {
  await db.delete(schema.opsEvents)
})

describe('parseRefAdvertisement', () => {
  it('reads refs/heads/main, not another branch', () => {
    expect(parseRefAdvertisement(ADVERTISEMENT)).toBe(HEAD)
    expect(parseRefAdvertisement(ADVERTISEMENT, 'feat/other')).toBe('a'.repeat(40))
  })

  it('is null when the ref is absent or the body is not an advertisement', () => {
    expect(parseRefAdvertisement(ADVERTISEMENT, 'nope')).toBeNull()
    expect(parseRefAdvertisement('<html>rate limited</html>')).toBeNull()
  })
})

describe('fetchMainHead', () => {
  it('asks the smart-HTTP endpoint and parses the answer', async () => {
    let url = ''
    const head = await fetchMainHead('https://github.com/o/r/', async (input) => {
      url = String(input)
      return new Response(ADVERTISEMENT)
    })
    expect(url).toBe('https://github.com/o/r.git/info/refs?service=git-upload-pack')
    expect(head).toBe(HEAD)
  })

  it('is null on a non-2xx or a network error', async () => {
    expect(
      await fetchMainHead('https://github.com/o/r', async () => new Response('', { status: 503 })),
    ).toBeNull()
    expect(
      await fetchMainHead('https://github.com/o/r', async () => {
        throw new Error('offline')
      }),
    ).toBeNull()
  })
})

describe('checkDeployDrift', () => {
  it('is quiet when production runs main', async () => {
    const marker = memoryMarker()
    expect((await checkDeployDrift(db, marker, HEAD, HEAD, at('17:00'))).verdict).toBe('in-sync')
    expect(marker.values.size).toBe(0)
  })

  it('says nothing it cannot know: no build sha, or no head', async () => {
    expect((await checkDeployDrift(db, memoryMarker(), '', HEAD)).verdict).toBe('unknown')
    expect((await checkDeployDrift(db, memoryMarker(), DEPLOYED, null)).verdict).toBe('unknown')
    expect(await driftEvents()).toHaveLength(0)
  })

  it('treats one disagreeing tick as a deploy in flight', async () => {
    const marker = memoryMarker()
    expect((await checkDeployDrift(db, marker, DEPLOYED, HEAD, at('17:00'))).verdict).toBe(
      'pending',
    )
    expect(marker.values.has(driftMarkerKey(HEAD))).toBe(true)
    expect(await driftEvents()).toHaveLength(0)
  })

  it('spools one event on the next tick, and again only after the renotify window', async () => {
    const marker = memoryMarker()
    await checkDeployDrift(db, marker, DEPLOYED, HEAD, at('17:00'))
    expect((await checkDeployDrift(db, marker, DEPLOYED, HEAD, at('17:30'))).verdict).toBe('drift')
    expect((await checkDeployDrift(db, marker, DEPLOYED, HEAD, at('18:00'))).verdict).toBe(
      'already-notified',
    )

    const events = await driftEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.detail).toContain('production runs c2aa4d1 but main has been at 188fab3')
    expect(events[0]!.path).toBe('/api/status')

    const later = new Date(at('17:30').getTime() + DRIFT_RENOTIFY_MS)
    expect((await checkDeployDrift(db, marker, DEPLOYED, HEAD, later)).verdict).toBe('drift')
    expect(await driftEvents()).toHaveLength(2)
  })

  it('restarts the clock when main moves to a new head', async () => {
    const marker = memoryMarker()
    await checkDeployDrift(db, marker, DEPLOYED, HEAD, at('17:00'))
    const next = 'b'.repeat(40)
    expect((await checkDeployDrift(db, marker, DEPLOYED, next, at('17:30'))).verdict).toBe(
      'pending',
    )
    expect(await driftEvents()).toHaveLength(0)
  })
})
