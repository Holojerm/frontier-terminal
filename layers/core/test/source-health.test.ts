// Degraded sources on the coverage panel (server/utils/source-health.ts),
// replayed on the two shapes that prompted it: a status feed refused for
// hours (mistral-status, issue #406) and docs pages that fail about one poll
// a day and recover (openai-*-md, issue #402).

import { beforeEach, describe, expect, it } from 'vitest'

const AS_OF = '2026-11-16T14:30:59.063Z'

let n = 0
function run(source_id: string, started_at: string, status: string) {
  n++
  return {
    id: `run-${n}`,
    scope: 'survey',
    source_id,
    started_at,
    status,
    detail: status === 'failed' ? 'HTTP 429' : null,
    snapshot_id: null,
    added: 0,
    removed: 0,
    modified: 0,
    source_url: 'https://example.com',
  }
}

/** One row per statement: D1 binds at most 100 variables to one. */
async function insertRuns(rows: ReturnType<typeof run>[]) {
  for (const r of rows) await db.insert(schema.sourceRuns).values(r)
}

beforeEach(async () => {
  await db.delete(schema.sourceRuns)
})

describe('sourceHealth', () => {
  const failed = { status: 'failed' as const }
  const ok = { status: 'unchanged' as const }

  it('a run of failed checks is failing once it passes six hours', () => {
    const since = new Date(Date.parse(AS_OF) - FAILING_AFTER_MS).toISOString()
    expect(sourceHealth(failed, 2, since, AS_OF)).toEqual({ kind: 'failing', since })
    const recent = new Date(Date.parse(AS_OF) - FAILING_AFTER_MS + 1000).toISOString()
    expect(sourceHealth(failed, 2, recent, AS_OF)).toBeNull()
  })

  it('a source that keeps failing and recovering is intermittent, even mid-failure', () => {
    expect(sourceHealth(ok, 5, null, AS_OF)).toEqual({
      kind: 'intermittent',
      failures: 5,
      window_days: 7,
    })
    const recent = new Date(Date.parse(AS_OF) - 60_000).toISOString()
    expect(sourceHealth(failed, 5, recent, AS_OF)).toMatchObject({ kind: 'intermittent' })
  })

  it('one or two failures in a week is not degraded', () => {
    expect(sourceHealth(ok, 2, null, AS_OF)).toBeNull()
    expect(sourceHealth(null, 0, null, AS_OF)).toBeNull()
  })
})

describe('sourceFailures', () => {
  it('dates a failing streak from the first failure after the last good check', async () => {
    await insertRuns([
      run('mistral-status', '2026-11-15T06:00:40.000Z', 'failed'),
      run('mistral-status', '2026-11-16T00:00:37.000Z', 'unchanged'),
      run('mistral-status', '2026-11-16T06:00:36.982Z', 'failed'),
      run('mistral-status', '2026-11-16T12:00:37.169Z', 'failed'),
      run('openai-pricing-md', '2026-11-13T07:31:02.000Z', 'failed'),
      run('openai-pricing-md', '2026-11-13T08:01:02.000Z', 'unchanged'),
      run('openai-pricing-md', '2026-11-13T12:31:01.000Z', 'failed'),
      run('openai-pricing-md', '2026-11-14T09:01:01.000Z', 'failed'),
      run('openai-pricing-md', '2026-11-16T14:30:59.063Z', 'unchanged'),
      // Outside the week: not counted.
      run('openai-pricing-md', '2026-11-01T00:00:00.000Z', 'failed'),
    ])
    const { failures, since } = await sourceFailures(db, ['mistral-status'], AS_OF)
    expect(failures.get('mistral-status')).toBe(3)
    expect(failures.get('openai-pricing-md')).toBe(3)
    expect([...since]).toEqual([['mistral-status', '2026-11-16T06:00:36.982Z']])

    expect(sourceHealth({ status: 'failed' }, 3, since.get('mistral-status')!, AS_OF)).toEqual({
      kind: 'failing',
      since: '2026-11-16T06:00:36.982Z',
    })
    expect(sourceHealth({ status: 'unchanged' }, 3, null, AS_OF)).toMatchObject({
      kind: 'intermittent',
      failures: 3,
    })
  })

  it('a source that has never passed dates its streak from its first check', async () => {
    await insertRuns([
      run('new-source', '2026-11-16T01:00:00.000Z', 'failed'),
      run('new-source', '2026-11-16T07:00:00.000Z', 'failed'),
    ])
    const { since } = await sourceFailures(db, ['new-source'], AS_OF)
    expect(since.get('new-source')).toBe('2026-11-16T01:00:00.000Z')
  })
})

describe('failing sources on every payload', () => {
  beforeEach(async () => {
    await db.delete(schema.sourceStats)
  })

  const stat = (source_id: string, last_run_at: string) =>
    db.insert(schema.sourceStats).values({ source_id, run_count: 1, last_run_at })

  it('names a source whose newest check ends six hours of failures, and no other', async () => {
    await insertRuns([
      run('mistral-status', '2026-11-16T00:00:39.000Z', 'unchanged'),
      run('mistral-status', '2026-11-16T06:00:36.982Z', 'failed'),
      run('mistral-status', '2026-11-16T12:00:40.000Z', 'failed'),
      // Failed once, an hour ago: a blip.
      run('openai-status', '2026-11-16T13:30:00.000Z', 'failed'),
      // Failed for a day, then recovered.
      run('xai-status', '2026-11-15T00:00:00.000Z', 'failed'),
      run('xai-status', '2026-11-16T12:00:00.000Z', 'ok'),
    ])
    await stat('mistral-status', '2026-11-16T12:00:40.000Z')
    await stat('openai-status', '2026-11-16T13:30:00.000Z')
    await stat('xai-status', '2026-11-16T12:00:00.000Z')

    expect(await failingSources(db, AS_OF)).toEqual({
      'mistral-status': '2026-11-16T06:00:36.982Z',
    })
    expect(await failingSources(db, null)).toEqual({})
  })

  it('stamps failing_since on the citations of a failing source, wherever they sit', () => {
    const cite = (source_id: string) => ({
      source_id,
      label: source_id,
      source_url: 'https://example.com',
      fetched_at: '2026-11-16T00:00:39.000Z',
    })
    const payload = {
      as_of: AS_OF,
      providers: [
        { provider: 'mistral', open: [{ id: 'i1' }], sources: [cite('mistral-status')] },
        { provider: 'openai', open: [], sources: [cite('openai-status')] },
      ],
      // Names a source without citing a read of it: left alone.
      coverage: [{ source_id: 'mistral-status', label: 'Mistral status' }],
    }
    const failing = { 'mistral-status': '2026-11-16T06:00:36.982Z' }
    const marked = markFailing(structuredClone(payload), failing)
    expect(marked.providers[0]!.sources[0]).toEqual({
      ...cite('mistral-status'),
      failing_since: '2026-11-16T06:00:36.982Z',
    })
    expect(marked.providers[1]).toEqual(payload.providers[1])
    expect(marked.coverage).toEqual(payload.coverage)
    expect(markFailing(payload, {})).toBe(payload)
  })
})
