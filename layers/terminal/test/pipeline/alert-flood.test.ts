import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '~~/server/db/schema'
import type { FetchOutcome, SourceFetcher } from '../../server/pipeline/fetch'
import type { LockStore } from '../../server/pipeline/lock'
import { runPoll, type PollDeps } from '../../server/pipeline/poll'
import type { RawStore } from '../../server/pipeline/refresh'
import type { PollScope } from '../../server/pipeline/contracts'
import { fixtureText, manifest } from './fixtures'

// The alert-flood regression, end to end: the cron entry point (runPoll) over
// the whole committed fixture world, the way dev:fixtures and the crons drive
// it. Two floods were real bugs: #80 (an edgar-fts 429 streak mailed every
// tick) and #84 (class-map and google-pricing alerting on every run). The unit
// tests pin each cause; this pins the symptom, whatever the cause, so a third
// one cannot ship as a flood.
//
// Caps are the measured behaviour, not a budget to grow into. A cold start is a
// baseline and alerts on nothing (refresh.test.ts › baseline), so pass 1 is
// capped at 0. If a deliberate change makes a cold start alert, raise the cap
// in the same PR and say why. A re-run of identical bytes is capped at 0.

const COLD_START_ALERT_CAP = 0
// One mail per failing source per outage, never one per tick (the #80 shape).
const OUTAGE_MAILS_PER_SOURCE_CAP = 1

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}

const world = () => new Map(manifest.fixtures.map((f) => [f.source_url, fixtureText(f.path)]))

// Sources discovered at run time (per-report disclosure pages, new models) have
// no committed fixture. They answer 404 as in dev:fixtures, and the counts below
// ignore them: their failures are the fixture world's gap, not the pipeline's.
const NO_FIXTURE: FetchOutcome = { ok: false, status: 404, detail: 'no fixture for this URL' }

function fixtureFetcher(): SourceFetcher {
  const byUrl = world()
  return async (source) => {
    const text = byUrl.get(source.url)
    if (text === undefined) return NO_FIXTURE
    return { ok: true, status: 200, text, bytes: text.length }
  }
}

const down =
  (outcome: FetchOutcome): SourceFetcher =>
  async () =>
    outcome

const memoryLock = (): LockStore => {
  let value: string | null = null
  return {
    get: async () => value,
    put: async (_k, v) => {
      value = v
    },
    delete: async () => {
      value = null
    },
  }
}

// Advances one second per read, so snapshot ids (time-derived) stay unique.
let tickMs = 0 // monotonic across scopes and ticks
const poll = (scope: PollScope, at: string, fetcher: SourceFetcher) => {
  tickMs = Math.max(tickMs, Date.parse(at))
  const deps: PollDeps = {
    db,
    raw,
    fetcher,
    sourcesYaml,
    lock: memoryLock(),
    now: () => new Date((tickMs += 1000)),
    surveyLockRetry: { retries: 0, delayMs: 0 },
  }
  return runPoll(scope, deps)
}

/** The scopes the crons run, in one tick's order. `at` is not a survey instant for edgar. */
async function tick(at: string, fetcher: SourceFetcher) {
  for (const scope of ['survey', 'careers', 'edgar'] as const) await poll(scope, at, fetcher)
}

const counts = async () => ({
  alerts: (await db.select().from(schema.alerts)).length,
  ops: (await db.select().from(schema.opsEvents)).filter((o) => o.path && world().has(o.path))
    .length,
})

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const table of [
    schema.sourceRuns,
    schema.sourceStats,
    schema.alerts,
    schema.changes,
    schema.entities,
    schema.snapshots,
    schema.opsEvents,
    schema.classMapDecisions,
  ]) {
    await db.delete(table)
  }
})

describe('alert flood', () => {
  it('a cold start alerts at most the cap, and the same bytes again alert nothing', async () => {
    await tick('2026-09-09T01:30:00Z', fixtureFetcher())
    const first = await counts()
    expect(first.alerts).toBeLessThanOrEqual(COLD_START_ALERT_CAP)
    // Guard against a vacuous pass: the world really was polled.
    expect((await db.select().from(schema.snapshots)).length).toBeGreaterThan(40)

    await tick('2026-09-09T07:30:00Z', fixtureFetcher())
    await tick('2026-09-09T13:30:00Z', fixtureFetcher())
    const after = await counts()
    expect(after.alerts).toBe(first.alerts)
    expect(after.ops).toBe(first.ops)
  })

  it('a day-long total outage mails each source at most once and raises no alerts', async () => {
    await tick('2026-09-09T01:30:00Z', fixtureFetcher())
    const baseline = await counts()

    const outage = down({ ok: false, status: 429, detail: 'HTTP 429' })
    for (const hour of ['07', '13', '19']) await tick(`2026-09-09T${hour}:30:00Z`, outage)
    await tick('2026-09-10T01:30:00Z', outage)

    expect((await counts()).alerts).toBe(baseline.alerts)
    const perSource = new Map<string, number>()
    for (const o of await db.select().from(schema.opsEvents)) {
      if (o.path && world().has(o.path)) perSource.set(o.path, (perSource.get(o.path) ?? 0) + 1)
    }
    expect(perSource.size).toBeGreaterThan(0)
    expect(Math.max(...perSource.values())).toBeLessThanOrEqual(OUTAGE_MAILS_PER_SOURCE_CAP)
  })
})
