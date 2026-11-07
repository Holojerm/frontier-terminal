import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import type { SourceFetcher } from '../server/pipeline/fetch'
import { contentHash } from '../server/pipeline/contracts'
import { runRefresh, type RawStore } from '../server/pipeline/refresh'
import { includeSources } from '../server/pipeline/sources'
import { insertRows } from '../server/pipeline/store'
import {
  AS_OF_ROUTES,
  AsOfInstant,
  PointInTimeError,
  assertKnowable,
  entitiesAt,
  judgeCutoffAt,
  pollStampAt,
} from '../server/utils/terminal-asof'
import { isCacheableDocument } from '../server/utils/html-cache'
import { terminalCacheKey, terminalStamp } from '../server/utils/terminal-cache'
import {
  queryAlerts,
  queryContext,
  queryHiring,
  queryHiringHistory,
  queryPriceHistory,
  queryPrices,
  type QueryContext,
} from '../server/utils/terminal-db'
import { collect, csvChunks, exportTable, jsonChunks } from '../server/utils/terminal-export'
import { queryRevenue } from '../server/utils/terminal-revenue'
import { fixtureText, manifest } from './pipeline/fixtures'

// Point-in-time reads. The golden property: a query asked `as_of` an instant
// returns what the same query returned live at that instant, after the store
// has moved on. Seeded the way production is — the fixtures through
// runRefresh — then edited and polled again, so the change log in between is
// the pipeline's own.

// A poll of every fixture source takes seconds in workerd.
const POLLS = { timeout: 60_000 }

const db = drizzle(env.DB, { schema })
// This store runs in September 2026, before some revenue_filers entries took
// effect. The round-trip tests below compare a live read then with an as_of
// read now, so they read the block as if every entry had always held; the
// effective dates have their own test.
const datedYaml = fixtureText('sources.yaml')
const sourcesYaml = datedYaml.replace(/^ {4}effective: .*\n/gm, '')
const ALL = includeSources(sourcesYaml, manifest.fixtures)
const ALL_IDS = ALL.map((s) => s.source_id)

const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}

function fetcher(overrides: Record<string, string> = {}): SourceFetcher {
  const byUrl = new Map(manifest.fixtures.map((f) => [f.source_url, fixtureText(f.path)]))
  return async (source) => {
    const text = overrides[source.source_id] ?? byUrl.get(source.url)
    if (text === undefined) throw new Error(`no fixture for ${source.url}`)
    return { ok: true, status: 200, text, bytes: text.length }
  }
}

let tick = Date.parse('2026-09-07T10:00:00Z')
const now = () => new Date((tick += 1000))
const poll = (overrides: Record<string, string> = {}) =>
  runRefresh({ db, raw, fetcher: fetcher(overrides), sourcesYaml, now }, 'survey', ALL_IDS)

/** The instant just after the newest poll, before the next. */
const between = () => new Date(tick + 500).toISOString()

const live = async (clock: string): Promise<QueryContext> =>
  queryContext(sourcesYaml, await terminalStamp(db), () => new Date(clock))
const asOf = async (at: string, clock = at): Promise<QueryContext> =>
  queryContext(sourcesYaml, await pollStampAt(db, at), () => new Date(clock), at)

// The pipeline's own edits, as terminal-db.test.ts makes them.
const XAI_PRICE_LINE = '| grok-4.7 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |'
const repriced = () =>
  fixtureText('fixtures/pricing/xai-models.md')
    .replace(XAI_PRICE_LINE, XAI_PRICE_LINE.replace('$2.00', '$2.50'))
    .split('\n')
    .filter((line) => !line.startsWith('| grok-build-0.1 ('))
    .join('\n')
const REMOVED_JOB = 5090171007
const boardWithout = (id: number) => {
  const board = JSON.parse(fixtureText('fixtures/hiring/xai-greenhouse.json')) as {
    jobs: { id: number }[]
  }
  return JSON.stringify({ ...board, jobs: board.jobs.filter((j) => j.id !== id) })
}

beforeEach(async () => {
  for (const table of [
    schema.sourceRuns,
    schema.sourceStats,
    schema.alerts,
    schema.changes,
    schema.entities,
    schema.snapshots,
    schema.judgeRuns,
  ]) {
    await db.delete(table)
  }
})

describe('as_of', () => {
  it('takes a zoned ISO timestamp, in UTC milliseconds, and nothing vaguer', () => {
    expect(AsOfInstant.parse('2026-09-07T12:00:00+02:00')).toBe('2026-09-07T10:00:00.000Z')
    expect(AsOfInstant.parse('2026-09-07T10:00:00Z')).toBe('2026-09-07T10:00:00.000Z')
    expect(AsOfInstant.safeParse('2026-09-07').success).toBe(false)
    expect(AsOfInstant.safeParse('2026-09-07T10:00:00').success).toBe(false)
    expect(AsOfInstant.safeParse('yesterday').success).toBe(false)
    const future = AsOfInstant.safeParse(new Date(Date.now() + 3_600_000).toISOString())
    expect(future.success).toBe(false)
    expect(future.error?.issues[0]?.message).toBe('as_of is in the future')
  })

  it('refuses an instant before the first snapshot, and an empty store', POLLS, async () => {
    await expect(assertKnowable(db, '2026-09-07T10:00:00.000Z')).rejects.toBeInstanceOf(
      PointInTimeError,
    )
    await poll()
    await expect(assertKnowable(db, '2026-09-07T09:00:00.000Z')).rejects.toThrow(
      /before the first snapshot \(2026-09-07T10:00:\d\d/,
    )
    await expect(assertKnowable(db, between())).resolves.toBeUndefined()
  })
})

// Every API route as source text, keyed by its URL path ('/api/prices/<key>').
const ROUTES = Object.fromEntries(
  Object.entries(
    import.meta.glob('/layers/terminal/server/api/**/*.get.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).map(([file, source]) => [
    file
      .replace(/^.*\/server/, '')
      .replace(/\.get\.ts$/, '')
      .replace(/\[(\w+)\]/g, '<$1>'),
    source,
  ]),
)

describe('which routes answer as_of', () => {
  it('lists every route that rebuilds its payload as of T, and no other', () => {
    const answering = Object.keys(ROUTES)
      .filter((path) =>
        /serveTerminalAsOf|serveTerminalFiled|terminalPayloadAt|parseAsOfQuery/.test(ROUTES[path]!),
      )
      .sort()
    expect(answering).toEqual([...AS_OF_ROUTES].sort())
  })

  it('refuses as_of on the page payload rather than serving today’s page under it', () => {
    expect(ROUTES['/api/page-data']).toMatch(/refuseAsOf\(event, 'page-data'\)/)
  })
})

describe('caches', () => {
  it('never let a historical answer and the live one share an entry', () => {
    // A page with any query string is neither served from nor stored in the HTML cache.
    expect(isCacheableDocument({ method: 'GET', path: '/prices' })).toBe(true)
    expect(isCacheableDocument({ method: 'GET', path: '/prices?as_of=2026-10-01T00:00:00Z' })).toBe(
      false,
    )
    // terminalPayloadAt keys on the instant (terminal-handler.ts › cacheName).
    const stamp = '2026-10-02T00:00:00.000Z'
    expect(terminalCacheKey('prices@dev', stamp)).not.toBe(
      terminalCacheKey('prices@dev:|as_of=2026-10-01T00:00:00.000Z', stamp),
    )
  })
})

describe('a store that has moved on answers as it did then', () => {
  it('prices, one SKU’s series, hiring, hiring history and revenue', POLLS, async () => {
    await poll()
    const t1 = between()
    const before = {
      prices: await queryPrices(db, await live(t1)),
      sku: await queryPriceHistory(db, await live(t1), 'model:xai:grok-4.7:standard'),
      hiring: await queryHiring(db, await live(t1)),
      history: await queryHiringHistory(db, await live(t1)),
      revenue: await queryRevenue(db, await live(t1)),
    }
    expect(before.sku).not.toBeNull()

    tick += 3_600_000
    await poll({ 'xai-models-md': repriced(), 'xai-greenhouse': boardWithout(REMOVED_JOB) })
    const moved = await queryPrices(db, await live(t1))
    expect(moved.rows).not.toEqual(before.prices.rows)

    const c = await asOf(t1)
    expect(await queryPrices(db, c)).toEqual(before.prices)
    expect(await queryPriceHistory(db, c, 'model:xai:grok-4.7:standard')).toEqual(before.sku)
    expect(await queryHiring(db, c)).toEqual(before.hiring)
    expect(await queryHiringHistory(db, c)).toEqual(before.history)
    expect(await queryRevenue(db, c)).toEqual(before.revenue)
    // Every row was rebuilt from a log that agrees with itself.
    expect([...c.notes.unverified]).toEqual([])
    expect([...c.notes.method].join(' ')).toContain('change log')
  })

  it('revenue as of T reads revenue_filers as dated, not today’s tags', POLLS, async () => {
    await poll()
    const t1 = between()
    const dated = queryContext(datedYaml, await pollStampAt(db, t1), () => new Date(t1), t1)
    const revenue = await queryRevenue(db, dated)
    // Google's segment tag took effect on 2026-11-01: in September it was untagged.
    expect(revenue.providers.find((p) => p.provider === 'google')).toMatchObject({
      disclosure: 'none',
      filer: null,
    })
    expect([...dated.notes.method].join(' ')).toContain('revenue_filers as it stood at as_of')
  })

  it('a SKU first listed after T is not there at T', POLLS, async () => {
    await poll()
    const t1 = between()
    expect(await queryPriceHistory(db, await asOf(t1), 'model:xai:grok-9:standard')).toBeNull()
  })
})

describe('alerts as of T', () => {
  const alert = (id: string, rule: string, created_at: string) => ({
    id: contentHash({ id }),
    severity: 'notable',
    headline: id,
    explanation: id,
    change_ids: '[]',
    rule,
    created_at,
    source_url: 'https://example.com',
    fetched_at: created_at,
  })

  it('holds a judge alert back until a judge run that could have written it', async () => {
    await insertRows(db, 'alerts', [
      alert('floor', 'model-floor', '2026-09-07T10:00:00.000Z'),
      alert('judged', 'agent-judge', '2026-09-07T10:00:00.000Z'),
      alert('later', 'model-floor', '2026-09-07T12:00:00.000Z'),
    ])
    await db.insert(schema.judgeRuns).values([
      // A run that accepted nothing does not count.
      run('empty', '2026-09-07T10:20:00.000Z', 0),
      run('wrote', '2026-09-07T11:00:00.000Z', 1),
    ])
    const headlines = async (at: string) =>
      (await queryAlerts(db, await asOf(at), 50)).rows.map((r) => r.headline).sort()

    expect(await headlines('2026-09-07T10:30:00.000Z')).toEqual(['floor'])
    expect(await headlines('2026-09-07T11:30:00.000Z')).toEqual(['floor', 'judged'])
    expect(await headlines('2026-09-07T12:30:00.000Z')).toEqual(['floor', 'judged', 'later'])
    expect((await queryAlerts(db, await asOf('2026-09-07T10:30:00.000Z'), 50)).total).toBe(1)
    expect(await judgeCutoffAt(db, '2026-09-07T10:59:00.000Z')).toBeNull()
  })

  function run(id: string, started_at: string, accepted: number) {
    return {
      id,
      started_at,
      judged_through: started_at,
      changes_seen: 1,
      accepted,
      rejected: 0,
      rejection_reason: null,
      source: 'test',
    }
  }
})

describe('exports as of T', () => {
  it(
    'cut append-only tables at T, rebuild entity views, and refuse what is not kept',
    POLLS,
    async () => {
      await poll()
      const t1 = between()
      const jobsThen = await collect(jsonChunks(db, exportTable('jobs_open')!))
      tick += 3_600_000
      await poll({ 'xai-greenhouse': boardWithout(REMOVED_JOB) })

      const snapshots = JSON.parse(
        await collect(jsonChunks(db, await exportTable('snapshots')!.at(db, t1))),
      ) as { fetched_at: string }[]
      expect(snapshots.length).toBe(ALL_IDS.length)
      expect(snapshots.every((s) => s.fetched_at <= t1)).toBe(true)

      const changes = await collect(csvChunks(db, await exportTable('changes')!.at(db, t1)))
      expect(changes.trim().split('\r\n')).toHaveLength(1) // the header: nothing had changed yet

      // The rebuilt view pages across several keyset pages and matches the live one at T.
      const jobs = JSON.parse(
        await collect(jsonChunks(db, await exportTable('jobs_open')!.at(db, t1))),
      ) as Record<string, unknown>[]
      const then = JSON.parse(jobsThen) as Record<string, unknown>[]
      expect(jobs.map(({ as_of_verified: _v, ...row }) => row)).toEqual(then)
      expect(jobs.every((j) => j.as_of_verified === true)).toBe(true)
      expect(Object.keys(jobs[0]!).slice(-3)).toEqual([
        'as_of_verified',
        'source_url',
        'fetched_at',
      ])

      await expect(exportTable('claim_readings')!.at(db, t1)).rejects.toThrow(/rewritten in place/)
      await expect(exportTable('recipe_observations')!.at(db, t1)).rejects.toThrow(
        /rewritten in place/,
      )
      expect(exportTable('claim_readings')!.asOfRefusal).toMatch(/not kept/)
      expect(exportTable('changes')!.asOfRefusal).toBeNull()
    },
  )
})

describe('entitiesAt: the set at T from the current set and the log', () => {
  const T = '2026-09-10T00:00:00.000Z'
  const URL_ = 'https://example.com/board'
  const first = { source_id: 'board', fetched_at: '2026-09-01T00:00:00.000Z' }
  const entity = (key: string, hash: string, fetched_at: string, first_seen_at = fetched_at) => ({
    source_id: 'board',
    entity_key: key,
    entity_type: 'job',
    provider: 'xai',
    content_hash: hash,
    payload: JSON.stringify({ hash }),
    snapshot_id: `board:${fetched_at}`,
    first_seen_at,
    source_url: URL_,
    fetched_at,
  })
  const change = (
    key: string,
    type: 'added' | 'removed' | 'modified',
    before: string | null,
    after: string | null,
    at: string,
  ) => ({
    id: contentHash({ key, before, after, at }),
    entity_key: key,
    entity_type: 'job',
    provider: 'xai',
    change_type: type,
    before_hash: before,
    after_hash: after,
    before_json: before && JSON.stringify({ hash: before }),
    after_json: after && JSON.stringify({ hash: after }),
    detected_at: at,
    source_url: URL_,
    fetched_at: at,
  })
  const at = (current: ReturnType<typeof entity>[], log: ReturnType<typeof change>[]) =>
    entitiesAt(current, log, T, () => first)
  const hashes = (r: ReturnType<typeof at>) =>
    r.rows.map((e) => `${e.entity_key}=${e.content_hash}`)

  it('undoes what happened after T', () => {
    const r = at(
      [
        entity('job:a', 'a2', '2026-09-12T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
        entity('job:new', 'n1', '2026-09-12T00:00:00.000Z'),
        entity('job:late-baseline', 'l1', '2026-09-11T00:00:00.000Z'),
      ],
      [
        change('job:a', 'modified', 'a1', 'a2', '2026-09-12T00:00:00.000Z'),
        change('job:new', 'added', null, 'n1', '2026-09-12T00:00:00.000Z'),
        change('job:gone', 'added', null, 'g1', '2026-09-05T00:00:00.000Z'),
        change('job:gone', 'removed', 'g1', null, '2026-09-12T00:00:00.000Z'),
      ],
    )
    expect(hashes(r)).toEqual(['job:a=a1', 'job:gone=g1'])
    expect(r.unverified).toEqual([])
    const a = r.rows[0]!
    // The baseline observed a1; the reopened role was observed when it was added.
    expect(a.fetched_at).toBe(first.fetched_at)
    expect(a.snapshot_id).toBe(`board:${first.fetched_at}`)
    expect(r.rows[1]!.fetched_at).toBe('2026-09-05T00:00:00.000Z')
    expect(r.changes.map((c) => c.entity_key)).toEqual(['job:gone'])
  })

  it('keeps a row written by T as it stands', () => {
    const r = at(
      [entity('job:a', 'a2', '2026-09-08T00:00:00.000Z', '2026-09-01T00:00:00.000Z')],
      [change('job:a', 'modified', 'a1', 'a2', '2026-09-08T00:00:00.000Z')],
    )
    expect(hashes(r)).toEqual(['job:a=a2'])
    expect(r.unverified).toEqual([])
  })

  it('flags a key whose log disagrees with itself instead of trusting it', () => {
    // The role was removed and, per the log, never came back — yet it is
    // listed after T with no change after T. A skipped duplicate 'added'.
    const r = at(
      [entity('job:flap', 'f1', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')],
      [
        change('job:flap', 'added', null, 'f1', '2026-09-03T00:00:00.000Z'),
        change('job:flap', 'removed', 'f1', null, '2026-09-04T00:00:00.000Z'),
      ],
    )
    expect(hashes(r)).toEqual([])
    expect(r.unverified).toEqual([])

    // Here the change after T starts from a state the log before T never reached.
    const broken = at(
      [entity('job:b', 'b3', '2026-09-12T00:00:00.000Z', '2026-09-01T00:00:00.000Z')],
      [
        change('job:b', 'modified', 'b1', 'b2', '2026-09-05T00:00:00.000Z'),
        change('job:b', 'modified', 'b9', 'b3', '2026-09-12T00:00:00.000Z'),
      ],
    )
    expect(hashes(broken)).toEqual(['job:b=b9'])
    expect(broken.unverified).toEqual(['job:b'])

    // Deleted with no removal logged: when is unknown, so it is flagged.
    const vanished = at([], [change('job:v', 'added', null, 'v1', '2026-09-05T00:00:00.000Z')])
    expect(hashes(vanished)).toEqual(['job:v=v1'])
    expect(vanished.unverified).toEqual(['job:v'])
  })

  it('reads an unlogged rewrite after T as the log’s own state at T', () => {
    const r = at(
      [entity('job:r', 'r2', '2026-09-12T00:00:00.000Z', '2026-09-01T00:00:00.000Z')],
      [change('job:r', 'modified', 'r0', 'r1', '2026-09-05T00:00:00.000Z')],
    )
    expect(hashes(r)).toEqual(['job:r=r1'])
    expect(r.unverified).toEqual([])
  })

  it('leaves out a baseline taken after T', () => {
    const r = entitiesAt([entity('job:x', 'x1', '2026-09-12T00:00:00.000Z')], [], T, () => ({
      source_id: 'board',
      fetched_at: '2026-09-12T00:00:00.000Z',
    }))
    expect(r.rows).toEqual([])
  })
})
