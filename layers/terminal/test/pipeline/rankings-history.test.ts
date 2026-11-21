import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import type { SourceFetcher } from '../../server/pipeline/fetch'
import {
  backfillWindows,
  RANKINGS_SOURCE_ID,
  windowRows,
  windowUrl,
} from '../../server/pipeline/rankings-history'
import { runRefresh, type RawStore, type RefreshDeps } from '../../server/pipeline/refresh'
import { fixtureText } from './fixtures'

// The rankings backfill (scripts/rankings-backfill.ts): windows from the
// dataset's first day, rows the live lane can sit beside, and a live tick
// that neither re-reads nor announces them.

const FIXTURE = 'fixtures/rankings/openrouter-rankings-daily.json'
const db = drizzle(env.DB, { schema })
const DAY_MS = 86_400_000
const span = (w: { start: string; end: string }) =>
  (Date.parse(w.end) - Date.parse(w.start)) / DAY_MS

const history = (start: string, end: string, data: object[]) =>
  JSON.stringify({
    data,
    meta: { as_of: '2026-11-20T12:00:00.000Z', version: 'v1', start_date: start, end_date: end },
  })
const row = (date: string, model_permaslug: string, total_tokens: string) => ({
  date,
  model_permaslug,
  total_tokens,
})

describe('backfillWindows', () => {
  it('reaches 2025-01-01 from the day before the oldest stored, newest first, within the 366-day cap', () => {
    const windows = backfillWindows('2026-08-10')
    expect(windows).toEqual([
      { start: '2025-08-09', end: '2026-08-09' },
      { start: '2025-01-01', end: '2025-08-08' },
    ])
    for (const w of windows) expect(span(w)).toBeLessThanOrEqual(366)
  })

  it('asks for nothing once the oldest stored day is the first day of the dataset', () => {
    expect(backfillWindows('2025-01-01')).toEqual([])
    expect(backfillWindows('2025-01-02')).toEqual([{ start: '2025-01-01', end: '2025-01-01' }])
  })
})

describe('windowRows', () => {
  const window = { start: '2026-08-08', end: '2026-08-09' }
  const text = history(window.start, window.end, [
    row('2026-08-08', 'anthropic/claude-sonnet-5-20260630', '100'),
    row('2026-08-09', 'openai/gpt-5.6-luna-20260709', '200'),
    row('2026-08-09', 'other', '50'),
  ])

  it('is a snapshot and ranking entities citing the windowed URL', () => {
    const at = '2026-11-20T12:00:01.000Z'
    const out = windowRows(window, text, at)
    const url = windowUrl(window)
    expect(url).toBe(
      'https://openrouter.ai/api/v1/datasets/rankings-daily?start_date=2026-08-08&end_date=2026-08-09',
    )
    expect(out.snapshot).toMatchObject({
      id: `${RANKINGS_SOURCE_ID}:${at}`,
      raw_key: `raw/${RANKINGS_SOURCE_ID}/${at}.json`,
      source_url: url,
      fetched_at: at,
    })
    expect(out.entities.map((e) => [e.entity_key, e.provider])).toEqual([
      ['ranking:2026-08-08:anthropic/claude-sonnet-5-20260630', 'anthropic'],
      ['ranking:2026-08-09:openai/gpt-5.6-luna-20260709', 'openai'],
      ['ranking:2026-08-09:other', 'other'],
    ])
    for (const e of out.entities) {
      expect(e).toMatchObject({ source_url: url, snapshot_id: out.snapshot.id, first_seen_at: at })
    }
  })

  it('refuses an answer for other dates than asked, and a row outside the window', () => {
    const at = '2026-11-20T12:00:01.000Z'
    expect(() => windowRows(window, history('2025-01-01', window.end, []), at)).toThrow(
      'OpenRouter answered 2025-01-01..2026-08-09',
    )
    const stray = history(window.start, window.end, [row('2026-08-10', 'other', '1')])
    expect(() => windowRows(window, stray, at)).toThrow('row dated 2026-08-10 outside')
  })
})

describe('beside the live source', () => {
  const raw: RawStore = { put: async (key, body) => void (await env.BLOB.put(key, body)) }
  let tick = Date.parse('2026-09-09T12:01:00Z')
  const deps = (text: string): RefreshDeps => ({
    db,
    raw,
    fetcher: (async () => ({ ok: true, status: 200, text, bytes: text.length })) as SourceFetcher,
    sourcesYaml: fixtureText('sources.yaml'),
    now: () => new Date((tick += 1000)),
  })

  beforeEach(async () => {
    for (const table of [
      schema.sourceRuns,
      schema.sourceStats,
      schema.changes,
      schema.entities,
      schema.snapshots,
    ]) {
      await db.delete(table)
    }
  })

  it('a live tick after a backfill logs only its own revision and leaves the history alone', async () => {
    const live = fixtureText(FIXTURE)
    await runRefresh(deps(live), 'survey', [RANKINGS_SOURCE_ID])

    const window = backfillWindows('2026-08-10').at(-1)!
    const back = windowRows(
      window,
      history(window.start, window.end, [row(window.start, 'other', '7')]),
      '2026-11-20T12:00:00.000Z',
    )
    await db.insert(schema.snapshots).values(back.snapshot)
    await db.insert(schema.entities).values(back.entities)

    const doc = JSON.parse(live) as { data: { date: string; total_tokens: string }[] }
    doc.data.find((r) => r.date === '2026-09-08')!.total_tokens = '1'
    const report = await runRefresh(deps(JSON.stringify(doc)), 'survey', [RANKINGS_SOURCE_ID])
    expect(report.sources[0]).toMatchObject({ status: 'ok', added: 0, removed: 0, modified: 1 })

    const changes = await db.select().from(schema.changes)
    expect(changes.map((c) => c.change_type)).toEqual(['modified'])
    const kept = await db.select().from(schema.entities)
    expect(kept).toHaveLength(1531)
    expect(kept.find((e) => e.entity_key === `ranking:${window.start}:other`)).toMatchObject({
      source_url: windowUrl(window),
    })
  })
})
