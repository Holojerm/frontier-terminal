import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import layersLock from '~~/layers.lock.json'
import nuxtConfigSource from '~~/nuxt.config.ts?raw'
import * as schema from '~~/server/db/schema'
import { readScheduledTasks } from '~~/scripts/lib/scheduled-tasks'
import type { LockStore } from '../server/pipeline/lock'
import {
  FRESHNESS_CHECK_FAILED_KIND,
  checkFreshness,
  cronIntervalMs,
  freshnessMarkerKey,
  freshnessOf,
  expectedMarkerKey,
  taskHeartbeatCheck,
  taskMaxAgeMs,
  type FreshnessCheck,
} from '../server/utils/freshness'
import {
  TASK_CHECK_OVERRIDES,
  freshnessChecks,
  gdeltFreshnessCheck,
  pressDraftsFreshnessCheck,
  socialOutboxFreshnessCheck,
} from '../server/utils/terminal-freshness'
import { TERMINAL_OPS_SEVERITY } from '../server/utils/terminal-ops-severity'
import { recordHeartbeat, withHeartbeat } from '../server/utils/task-heartbeat'

// The freshness checks (server/utils/freshness.ts): the coverage gate that
// keeps every scheduled task and every producer off the Worker under one rule,
// then the rule itself, the heartbeat behind the task checks, and each
// producer's evidence against a real D1.

const db = drizzle(env.DB, { schema })
const SCHEDULED = readScheduledTasks(nuxtConfigSource)

// Every task file in the app and its layers, as source text.
const TASK_SOURCES = import.meta.glob(['/server/tasks/**/*.ts', '/layers/*/server/tasks/**/*.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function taskSource(name: string): { path: string; source: string } | null {
  const tail = `/server/tasks/${name.split(':').join('/')}.ts`
  const path = Object.keys(TASK_SOURCES).find((p) => p.endsWith(tail))
  return path ? { path, source: TASK_SOURCES[path]! } : null
}

function memoryMarker(): LockStore & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
  }
}

const deps = { scheduledTasks: SCHEDULED, drafted: async () => false, pressList: '' }

describe('coverage: every part of the pipeline has a freshness check', () => {
  const tasks = Object.entries(SCHEDULED).flatMap(([cron, names]) => names.map((n) => [n, cron]))

  it.each(tasks)('%s records a heartbeat, or the registry checks it another way', (name) => {
    const file = taskSource(name)
    expect(file, `no task file for ${name}`).not.toBeNull()
    if (TASK_CHECK_OVERRIDES[name]) return
    expect(
      file!.source,
      `${file!.path} must end in \`export default withHeartbeat(task)\` ` +
        '(layers/terminal/server/utils/task-heartbeat.ts), or have an entry in TASK_CHECK_OVERRIDES ' +
        '(layers/terminal/server/utils/terminal-freshness.ts) that says why not',
    ).toMatch(/^export default withHeartbeat\(task\)$/m)
  })

  it('has no override for a task that is not scheduled, and each says why', () => {
    const scheduled = new Set(tasks.map(([name]) => name))
    for (const [name, override] of Object.entries(TASK_CHECK_OVERRIDES)) {
      expect(scheduled.has(name), `${name} is overridden but not scheduled`).toBe(true)
      expect(override.reason.length).toBeGreaterThan(40)
    }
  })

  it('wraps every task file, scheduled or not, so a task added later is covered from its first run', () => {
    // A vendored layer's files are pinned by layers:check and cannot be edited
    // to add the wrapper. Its unscheduled tasks never run here (social:post:
    // the EVENTS queue drains the social outbox), and a scheduled one still
    // needs an override, which the test above enforces.
    const vendored = Object.keys(layersLock.layers).map((name) => `/layers/${name}/`)
    for (const [path, source] of Object.entries(TASK_SOURCES)) {
      const name = /\bname:\s*'([^']+)'/.exec(source)?.[1]
      if (name && TASK_CHECK_OVERRIDES[name]) continue
      if (vendored.some((prefix) => path.startsWith(prefix))) continue
      expect(source, path).toMatch(/^export default withHeartbeat\(task\)$/m)
    }
  })

  it('reads every cron in the map, and gives no task less than 30 minutes', () => {
    for (const cron of Object.keys(SCHEDULED)) {
      expect(taskMaxAgeMs(cron)).toBeGreaterThanOrEqual(30 * 60_000)
    }
  })

  it('builds one check per scheduled task plus each producer off the Worker, all keyed apart', () => {
    const checks = freshnessChecks(deps)
    const keys = checks.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const [name] of tasks) expect(keys).toContain(`task:${name}`)
    expect(keys).toEqual(
      expect.arrayContaining(['judge', 'gdelt-search', 'press-drafts', 'social-outbox']),
    )
  })

  it('gives every check’s kind, and the failure kind, a tier', () => {
    const kinds = new Set([
      ...freshnessChecks(deps).map((c) => c.kind),
      FRESHNESS_CHECK_FAILED_KIND,
    ])
    for (const kind of kinds) expect(TERMINAL_OPS_SEVERITY[kind], kind).toBeDefined()
    expect(TERMINAL_OPS_SEVERITY.judge_silent!.severity).toBe('critical')
  })
})

describe('the rule', () => {
  const NOW = new Date('2026-11-06T12:00:00Z')
  const H = 60 * 60_000
  const ago = (hours: number) => new Date(NOW.getTime() - hours * H).toISOString()

  it('is stale only when work has been owed past the limit and nothing succeeded within it', () => {
    expect(freshnessOf({ owedSince: ago(10), lastOkAt: ago(1) }, 3 * H, NOW)).toBe('fresh')
    expect(freshnessOf({ owedSince: null, lastOkAt: ago(10) }, 3 * H, NOW)).toBe('not-owed')
    expect(freshnessOf({ owedSince: ago(2), lastOkAt: null }, 3 * H, NOW)).toBe('not-owed')
    expect(freshnessOf({ owedSince: ago(4), lastOkAt: ago(5) }, 3 * H, NOW)).toBe('stale')
    expect(freshnessOf({ owedSince: ago(4), lastOkAt: null }, 3 * H, NOW)).toBe('stale')
    expect(freshnessOf({ owedSince: ago(4) }, 3 * H, NOW)).toBe('stale')
  })

  it('reads the interval of every cron shape the app schedules', () => {
    expect(cronIntervalMs('*/5 * * * *')).toBe(5 * 60_000)
    expect(cronIntervalMs('*/30 * * * *')).toBe(30 * 60_000)
    expect(cronIntervalMs('41 * * * *')).toBe(H)
    expect(cronIntervalMs('0 */6 * * *')).toBe(6 * H)
    expect(cronIntervalMs('17 */6 * * *')).toBe(6 * H)
    expect(cronIntervalMs('0 4 * * *')).toBe(24 * H)
    expect(cronIntervalMs('0 13 * * 1')).toBe(7 * 24 * H)
    expect(() => cronIntervalMs('0 13 1 * *')).toThrow('day-of-month')
    expect(() => cronIntervalMs('0,30 * * * *')).toThrow('not a shape')
  })

  it('allows one missed run plus half an interval, at least 30 minutes', () => {
    expect(taskMaxAgeMs('*/5 * * * *')).toBe(35 * 60_000)
    expect(taskMaxAgeMs('41 * * * *')).toBe(1.5 * H)
    expect(taskMaxAgeMs('0 */6 * * *')).toBe(9 * H)
  })
})

describe('checkFreshness', () => {
  const NOW = new Date('2026-11-06T12:00:00Z')
  beforeEach(async () => {
    await db.delete(schema.opsEvents)
  })

  const check = (owedSince: string | null, over: Partial<FreshnessCheck> = {}): FreshnessCheck => ({
    key: 'demo',
    label: 'The demo job',
    kind: 'task_silent',
    maxAgeMs: 60 * 60_000,
    evidence: async () => ({ owedSince, lastOkAt: null, note: 'it threw' }),
    ...over,
  })

  it('records a stale check once, then holds the repeat with the marker', async () => {
    const marker = memoryMarker()
    const owed = [check('2026-11-06T09:00:00.000Z')]
    expect(await checkFreshness(db, marker, owed, NOW)).toEqual({ demo: 'stale' })
    expect(await checkFreshness(db, marker, owed, NOW)).toEqual({ demo: 'already-notified' })
    expect(marker.values.get(freshnessMarkerKey('demo'))).toBe(NOW.toISOString())
    const events = await db.select().from(schema.opsEvents)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'task_silent' })
    expect(events[0]!.detail).toBe(
      'The demo job: work owed since 2026-11-06T09:00:00.000Z, no success ever (limit 1h); it threw',
    )
  })

  it('keeps going past a check whose evidence throws, and says which', async () => {
    const broken = check(null, {
      key: 'broken',
      evidence: async () => {
        throw new Error('no such table')
      },
    })
    const verdicts = await checkFreshness(
      db,
      memoryMarker(),
      [broken, check('2026-11-06T09:00:00.000Z')],
      NOW,
    )
    expect(verdicts).toEqual({ broken: 'check-failed', demo: 'stale' })
    const kinds = (await db.select().from(schema.opsEvents)).map((e) => e.kind).sort()
    expect(kinds).toEqual([FRESHNESS_CHECK_FAILED_KIND, 'task_silent'])
  })
})

describe('task heartbeats', () => {
  beforeEach(async () => {
    await db.delete(schema.taskHeartbeats)
    await db.delete(schema.opsEvents)
  })

  const clock = (iso: string) => () => new Date(iso)

  it('records a completed run, and a throw without hiding it', async () => {
    const ok = withHeartbeat(
      { meta: { name: 'demo:ok' }, run: async () => ({ result: 1 }) },
      () => db,
      clock('2026-11-06T10:00:00.000Z'),
    )
    expect(await ok.run({ name: 'demo:ok', payload: {}, context: {} })).toEqual({ result: 1 })

    const boom = withHeartbeat(
      {
        meta: { name: 'demo:boom' },
        run: async () => {
          throw new Error('CPU limit')
        },
      },
      () => db,
      clock('2026-11-06T10:05:00.000Z'),
    )
    await expect(boom.run({ name: 'demo:boom', payload: {}, context: {} })).rejects.toThrow(
      'CPU limit',
    )

    const rows = await db.select().from(schema.taskHeartbeats)
    expect(rows.find((r) => r.task === 'demo:ok')).toMatchObject({
      last_completed_at: '2026-11-06T10:00:00.000Z',
      last_failed_at: null,
    })
    expect(rows.find((r) => r.task === 'demo:boom')).toMatchObject({
      last_completed_at: null,
      last_failed_at: '2026-11-06T10:05:00.000Z',
      last_error: 'Error: CPU limit',
    })
  })

  it('keeps first_seen_at from the first run, and the task result when the write fails', async () => {
    const at = (iso: string, error: string | null = null) =>
      recordHeartbeat(db, { task: 't', started_at: iso, finished_at: iso, error })
    await at('2026-11-06T08:00:00.000Z')
    await at('2026-11-06T09:00:00.000Z', 'Error: x')
    await at('2026-11-06T10:00:00.000Z')
    const [row] = await db.select().from(schema.taskHeartbeats)
    expect(row).toMatchObject({
      first_seen_at: '2026-11-06T08:00:00.000Z',
      last_completed_at: '2026-11-06T10:00:00.000Z',
      last_failed_at: '2026-11-06T09:00:00.000Z',
    })

    const unwritable = withHeartbeat(
      { meta: { name: 'demo:ok' }, run: async () => ({ result: 'kept' }) },
      () => {
        throw new Error('D1 down')
      },
    )
    expect(await unwritable.run({ name: 'demo:ok', payload: {}, context: {} })).toEqual({
      result: 'kept',
    })
  })

  it('refuses a task with no name to key the row on', () => {
    expect(() => withHeartbeat({ run: async () => ({}) })).toThrow('no meta.name')
  })

  it('gives a task a deploy just added its full window before calling it silent', async () => {
    await recordHeartbeat(db, {
      task: 'ops:alert',
      started_at: '2026-11-06T10:00:00.000Z',
      finished_at: '2026-11-06T10:00:00.000Z',
      error: null,
    })
    const sweep = taskHeartbeatCheck('events:sweep', '41 * * * *')
    const marker = memoryMarker()
    const at = (iso: string) => new Date(iso)
    // Seen first at 17:30, before its first :41 run: not owed yet.
    expect(await checkFreshness(db, marker, [sweep], at('2026-11-07T17:30:00Z'))).toEqual({
      'task:events:sweep': 'not-owed',
    })
    expect(marker.values.get(expectedMarkerKey('events:sweep'))).toBe('2026-11-07T17:30:00.000Z')
    // Still inside its 90-minute limit an hour later.
    expect(await checkFreshness(db, marker, [sweep], at('2026-11-07T18:30:00Z'))).toEqual({
      'task:events:sweep': 'not-owed',
    })
    // Two hours with no run: silent.
    expect(await checkFreshness(db, marker, [sweep], at('2026-11-07T19:31:00Z'))).toEqual({
      'task:events:sweep': 'stale',
    })
  })

  it('says nothing before monitoring starts, then flags a task that never ran or keeps throwing', async () => {
    const hourly = taskHeartbeatCheck('bulk:build', '41 * * * *')
    const NOW = new Date('2026-11-06T12:00:00Z')
    expect(await checkFreshness(db, memoryMarker(), [hourly], NOW)).toEqual({
      'task:bulk:build': 'not-owed',
    })

    // Another task's first heartbeat starts monitoring; bulk:build never runs.
    await recordHeartbeat(db, {
      task: 'ops:alert',
      started_at: '2026-11-06T10:00:00.000Z',
      finished_at: '2026-11-06T10:00:00.000Z',
      error: null,
    })
    // A task the checker first expected three hours ago and that still has no row.
    const expectedEarlier = memoryMarker()
    expectedEarlier.values.set(expectedMarkerKey('bulk:build'), '2026-11-06T09:00:00.000Z')
    expect(await checkFreshness(db, expectedEarlier, [hourly], NOW)).toEqual({
      'task:bulk:build': 'stale',
    })
    const [never] = await db.select().from(schema.opsEvents)
    expect(never!.detail).toContain('it has never recorded a run')

    await db.delete(schema.opsEvents)
    await recordHeartbeat(db, {
      task: 'bulk:build',
      started_at: '2026-11-06T09:41:00.000Z',
      finished_at: '2026-11-06T09:41:30.000Z',
      error: null,
    })
    await recordHeartbeat(db, {
      task: 'bulk:build',
      started_at: '2026-11-06T11:41:00.000Z',
      finished_at: '2026-11-06T11:41:05.000Z',
      error: 'Error: Unexpected end of file',
    })
    expect(await checkFreshness(db, memoryMarker(), [hourly], NOW)).toEqual({
      'task:bulk:build': 'stale',
    })
    const [threw] = await db.select().from(schema.opsEvents)
    expect(threw!.detail).toContain(
      'it threw at 2026-11-06T11:41:05.000Z: Error: Unexpected end of file',
    )

    await recordHeartbeat(db, {
      task: 'bulk:build',
      started_at: '2026-11-06T11:50:00.000Z',
      finished_at: '2026-11-06T11:51:00.000Z',
      error: null,
    })
    expect(await checkFreshness(db, memoryMarker(), [hourly], NOW)).toEqual({
      'task:bulk:build': 'fresh',
    })
  })
})

describe('the producers off the Worker', () => {
  const NOW = new Date('2026-11-06T12:00:00Z')
  const HASH = (n: number) => n.toString(16).padStart(64, '0')

  beforeEach(async () => {
    await db.delete(schema.opsEvents)
    await db.delete(schema.trackRecordSearches)
    await db.delete(schema.alerts)
    await db.delete(schema.changes)
    await db.delete(schema.socialPosts)
  })

  it('flags the GDELT job when files have been owed for six hours and none was read', async () => {
    await db.delete(schema.gdeltFiles)
    const run = () => checkFreshness(db, memoryMarker(), [gdeltFreshnessCheck], NOW)
    // Nothing read: the queue has been owed since 2026-09-01.
    expect(await run()).toEqual({ 'gdelt-search': 'stale' })

    // A backlog still owed, but the job read a file two hours ago: it is working through it.
    await db.insert(schema.gdeltFiles).values({
      stamp: '20260901000000',
      url: 'http://data.gdeltproject.org/gdeltv2/20260901000000.gkg.csv.zip',
      status: 'ok',
      rows: 1200,
      matched: 0,
      raw_key: null,
      fetched_at: '2026-11-06T10:00:00.000Z',
      recorded_at: '2026-11-06T10:00:00.000Z',
    })
    expect(await run()).toEqual({ 'gdelt-search': 'fresh' })
  })

  it('says nothing for GDELT before any file is due', async () => {
    await db.delete(schema.gdeltFiles)
    const early = new Date('2026-09-01T00:20:00Z')
    expect(await checkFreshness(db, memoryMarker(), [gdeltFreshnessCheck], early)).toEqual({
      'gdelt-search': 'not-owed',
    })
  })

  it('flags a press note that has waited six hours, and only with a press list', async () => {
    await db.insert(schema.alerts).values({
      id: HASH(5),
      severity: 'critical',
      headline: 'A filing crosses the prospectus floor',
      explanation: 'S-1.',
      change_ids: '[]',
      rule: 'prospectus-floor',
      created_at: '2026-11-06T04:00:00.000Z',
      source_url: 'https://www.sec.gov/',
      fetched_at: '2026-11-06T04:00:00.000Z',
    })
    const list = JSON.stringify([
      { name: 'A Reporter', outlet: 'Wire', email: 'a@example.com', priority: 1 },
    ])
    const run = (drafted: boolean, pressList: string) =>
      checkFreshness(
        db,
        memoryMarker(),
        [pressDraftsFreshnessCheck(async () => drafted, pressList)],
        NOW,
      )
    expect(await run(false, '')).toEqual({ 'press-drafts': 'not-owed' })
    expect(await run(true, list)).toEqual({ 'press-drafts': 'not-owed' })
    expect(await run(false, list)).toEqual({ 'press-drafts': 'stale' })
    const [event] = await db.select().from(schema.opsEvents)
    expect(event!.detail).toContain('nothing records a success')
  })

  it('checks the social outbox by its rows: a due post still queued after an hour', async () => {
    const run = () => checkFreshness(db, memoryMarker(), [socialOutboxFreshnessCheck], NOW)
    expect(await run()).toEqual({ 'social-outbox': 'not-owed' })
    await db.insert(schema.socialPosts).values({
      service: 'x',
      kind: 'alert',
      ref: 'a1',
      body: 'hello',
      notBefore: new Date('2026-11-06T10:00:00Z'),
    })
    expect(await run()).toEqual({ 'social-outbox': 'stale' })
  })
})
