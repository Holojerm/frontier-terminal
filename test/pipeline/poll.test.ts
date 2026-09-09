import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '../../server/db/schema'
import type { SourceFetcher } from '../../server/pipeline/fetch'
import { POLL_LOCK_KEY, type LockStore } from '../../server/pipeline/lock'
import { runPoll, type PollDeps } from '../../server/pipeline/poll'
import type { RawStore } from '../../server/pipeline/refresh'
import { isSurveyInstant } from '../../server/pipeline/scopes'
import { fixtureText, manifest } from './fixtures'

// The cron-collision policy: edgar and the survey are both due at :00 of
// every sixth hour, and the survey must be the one that runs there. Observed
// failing in production 2026-09-09T00:00Z, when edgar won the lock twice in a
// row and the survey's sources went twelve hours stale.

describe('isSurveyInstant', () => {
  it.each([
    ['2026-09-09T00:00:05Z', true], // cron fired at :00, task started 5 s later
    ['2026-09-09T05:59:40Z', true], // an early start rounds forward to 06:00
    ['2026-09-09T06:00:00Z', true],
    ['2026-09-09T12:29:59Z', false], // rounds to 12:30 — an edgar-only tick
    ['2026-09-09T12:30:00Z', false],
    ['2026-09-09T23:59:59Z', true], // rounds to the next day's 00:00
    ['2026-09-09T03:00:02Z', false], // the middle of a survey window
  ])('%s → %s', (iso, expected) => {
    expect(isSurveyInstant(new Date(iso))).toBe(expected)
  })
})

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')

const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}

/** Every request answered from the committed fixtures, counted so a test can prove nothing was fetched. */
function fixtureFetcher(): SourceFetcher & { calls: number } {
  const byUrl = new Map(manifest.fixtures.map((f) => [f.source_url, fixtureText(f.path)]))
  const fetcher = async (source: { url: string }) => {
    fetcher.calls++
    const text = byUrl.get(source.url)
    if (text === undefined) throw new Error(`no fixture for ${source.url}`)
    return { ok: true as const, status: 200, text, bytes: text.length }
  }
  fetcher.calls = 0
  return fetcher
}

/** In-memory lock, recording every get so a test can prove the lock was never consulted. */
function memoryLock(): LockStore & { gets: number; value: string | null } {
  const lock = {
    gets: 0,
    value: null as string | null,
    get: async () => {
      lock.gets++
      return lock.value
    },
    put: async (_key: string, value: string) => {
      lock.value = value
    },
    delete: async () => {
      lock.value = null
    },
  }
  return lock
}

/** A clock that starts at `iso` and advances one second per read, so snapshot ids stay unique. */
function clockFrom(iso: string) {
  let tick = Date.parse(iso) - 1000
  return () => new Date((tick += 1000))
}

function deps(startAt: string, overrides: Partial<PollDeps> = {}) {
  const fetcher = fixtureFetcher()
  const lock = memoryLock()
  const all: PollDeps = {
    db,
    raw,
    fetcher,
    sourcesYaml,
    lock,
    now: clockFrom(startAt),
    surveyLockRetry: { retries: 2, delayMs: 5 },
    ...overrides,
  }
  return { all, fetcher, lock }
}

let warn: ReturnType<typeof vi.spyOn>
const warnings = () =>
  warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)

beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const table of [
    schema.sourceRuns,
    schema.snapshots,
    schema.entities,
    schema.changes,
    schema.alerts,
    schema.opsEvents,
  ]) {
    await db.delete(table)
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runPoll at a survey instant', () => {
  it('edgar yields without touching the lock or the network', async () => {
    const { all, fetcher, lock } = deps('2026-09-09T00:00:05Z')
    const outcome = await runPoll('edgar', all)
    expect(outcome).toEqual({ status: 'yielded', to: 'survey' })
    expect(lock.gets).toBe(0)
    expect(fetcher.calls).toBe(0)
    expect(await db.select().from(schema.sourceRuns)).toHaveLength(0)
    expect(warnings()).toEqual([{ kind: 'poll_yielded', scope: 'edgar', to: 'survey' }])
  })

  it('the survey runs, EDGAR included', async () => {
    const { all, fetcher } = deps('2026-09-09T00:00:08Z')
    const outcome = await runPoll('survey', all)
    expect(outcome.status).toBe('ran')
    if (outcome.status !== 'ran') return
    expect(outcome.result.scope).toBe('survey')
    expect(outcome.result.sources.map((s) => s.source_id)).toContain('edgar-fts')
    expect(outcome.result.failed).toBe(0)
    expect(fetcher.calls).toBeGreaterThan(0)
    expect(warnings().map((w) => w.kind)).toEqual(['poll_run'])
  })
})

describe('runPoll between survey instants', () => {
  it('edgar runs its two feeds', async () => {
    const { all } = deps('2026-09-09T00:30:03Z')
    const outcome = await runPoll('edgar', all)
    expect(outcome.status).toBe('ran')
    if (outcome.status !== 'ran') return
    expect(outcome.result.sources.map((s) => s.source_id)).toEqual([
      'edgar-fts',
      'edgar-submissions-spcx',
    ])
  })

  it('edgar skips a held lock at once, and that is only a log line', async () => {
    const { all, fetcher, lock } = deps('2026-09-09T00:30:03Z')
    lock.value = 'survey@2026-09-09T00:00:08.000Z'
    const outcome = await runPoll('edgar', all)
    expect(outcome).toEqual({ status: 'skipped', heldBy: 'survey@2026-09-09T00:00:08.000Z' })
    expect(lock.gets).toBe(1)
    expect(fetcher.calls).toBe(0)
    expect(await db.select().from(schema.opsEvents)).toHaveLength(0)
  })
})

describe('runPoll when the survey cannot get the lock', () => {
  it('retries, then records an ops event naming the holder', async () => {
    const { all, fetcher, lock } = deps('2026-09-09T06:00:04Z')
    lock.value = 'edgar@2026-09-09T05:30:01.000Z'
    const outcome = await runPoll('survey', all)
    expect(outcome).toEqual({ status: 'skipped', heldBy: 'edgar@2026-09-09T05:30:01.000Z' })
    expect(lock.gets).toBe(3) // first look plus the two retries the test configured
    expect(fetcher.calls).toBe(0)

    const ops = await db.select().from(schema.opsEvents)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({
      kind: 'poll_skipped',
      detail: 'survey: lock held by edgar@2026-09-09T05:30:01.000Z after 2 retries',
      path: null,
    })
    expect(warnings()).toEqual([
      { kind: 'poll_skipped', scope: 'survey', heldBy: 'edgar@2026-09-09T05:30:01.000Z' },
    ])
  })

  it('a holder that lets go during the retries is not a skip', async () => {
    const { all, lock } = deps('2026-09-09T06:00:04Z')
    lock.value = 'edgar@stale'
    setTimeout(() => {
      lock.value = null
    }, 7)
    const outcome = await runPoll('survey', all)
    expect(outcome.status).toBe('ran')
    expect(await db.select().from(schema.opsEvents)).toHaveLength(0)
  })
})
