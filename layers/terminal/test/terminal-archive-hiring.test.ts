import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { HISTORY_LICENSE, PAID_LICENSE } from '#shared/utils/license'
import type { SourceFetcher } from '../server/pipeline/fetch'
import { hiringEraById } from '../server/pipeline/archive/hiring-eras'
import { hiringRows } from '../server/pipeline/archive/rows'
import { runRefresh, type RawStore } from '../server/pipeline/refresh'
import { includeSources } from '../server/pipeline/sources'
import { PointInTimeError, pollStampAt } from '../server/utils/terminal-asof'
import { terminalStamp } from '../server/utils/terminal-cache'
import {
  assertArchiveKnowable,
  queryHiringReach,
  queryPriceReach,
} from '../server/utils/terminal-archive'
import { queryContext, queryHiring, queryHiringHistory } from '../server/utils/terminal-db'
import { exportTable, licenseWindow } from '../server/utils/terminal-export'
import { fixtureText, manifest } from './pipeline/fixtures'

// The archived hiring history on the read side: archived points before the
// live series on /api/hiring/history, /api/hiring as of an instant before our
// first fetch, the reach table and its gaps, and the walls around it (the
// price reach and the live counts never see a board copy).

const POLLS = { timeout: 60_000 }
const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const ALL = includeSources(sourcesYaml, manifest.fixtures)

const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}
const fetcher: SourceFetcher = async (source) => {
  const f = manifest.fixtures.find((x) => x.source_url === source.url)
  if (!f) throw new Error(`no fixture for ${source.url}`)
  const text = fixtureText(f.path)
  return { ok: true, status: 200, text, bytes: text.length }
}
let tick = Date.parse('2026-09-07T10:00:00Z')
const now = () => new Date((tick += 1000))
const poll = () =>
  runRefresh(
    { db, raw, fetcher, sourcesYaml, now },
    'survey',
    ALL.map((s) => s.source_id),
  )

const LEVER = hiringEraById('mistral-lever-2023')!
const FETCHED = '2026-11-05T00:00:00.000Z'
const lever = (groups: [string, number][]) =>
  groups
    .map(
      ([label, n], g) =>
        `<div class="postings-group"><div class="posting-category-title large-category-label">${label}</div>` +
        Array.from(
          { length: n },
          (_, i) => `<div class="posting" data-qa-posting-id="${g}-${i}"></div>`,
        ).join('') +
        '</div>',
    )
    .join('') + '</html>'

async function archive(timestamp: string, html: string) {
  const out = hiringRows(
    LEVER,
    { timestamp, original: LEVER.url, digest: timestamp },
    html,
    html.length,
    FETCHED,
  )
  await db.insert(schema.archiveCaptures).values(out.capture)
  if (out.counts.length) await db.insert(schema.archivedHiring).values(out.counts)
}

const live = async () => queryContext(sourcesYaml, await terminalStamp(db))
const asOf = async (at: string) =>
  queryContext(sourcesYaml, await pollStampAt(db, at), undefined, at)

beforeEach(async () => {
  for (const table of [
    schema.sourceRuns,
    schema.sourceStats,
    schema.changes,
    schema.entities,
    schema.snapshots,
    schema.archiveCaptures,
    schema.archivedPrices,
    schema.archivedHiring,
  ]) {
    await db.delete(table)
  }
  await archive(
    '20250101000000',
    lever([
      ['Research', 4],
      ['Infrastructure', 2],
    ]),
  )
  await archive('20250108000000', lever([['Research', 5]]))
  // Three months with nothing readable: one copy the Archive kept of an empty board.
  await archive('20250301000000', '<html><body>No job postings</body></html>')
  await archive('20250415000000', lever([['Research', 7]]))
})

describe('archived hiring history', () => {
  it('comes before the live series, labeled as archived', POLLS, async () => {
    await poll()
    const history = await queryHiringHistory(db, await live())
    const mistral = history.providers.find((p) => p.provider === 'mistral')!
    expect(mistral.archived.map((a) => [a.at, a.total, a.source_id, a.basis])).toEqual([
      ['2025-01-01T00:00:00.000Z', 6, 'wayback:mistral-lever-2023', 'archived'],
      ['2025-01-08T00:00:00.000Z', 5, 'wayback:mistral-lever-2023', 'archived'],
      ['2025-04-15T00:00:00.000Z', 7, 'wayback:mistral-lever-2023', 'archived'],
    ])
    expect(mistral.archived.every((a) => a.at < mistral.series_from!)).toBe(true)
    expect(mistral.archived[0]!.source_url).toBe(
      'https://web.archive.org/web/20250101000000id_/https://jobs.lever.co/mistral',
    )
    expect(mistral.archived[0]!.fetched_at).toBe(FETCHED)
    expect(mistral.archived[0]!.clusters![0]).toMatchObject({
      id: 'physical-infrastructure',
      open_roles: 2,
      departments: ['Infrastructure'],
    })
    expect(mistral.archive_caveat).toContain('Lever')
    expect(history.archive_method).toContain('event time, not knowledge time')
    // A lab with no archived board has none, and live counts never include a copy.
    expect(history.providers.find((p) => p.provider === 'meta')!.archived).toEqual([])
  })

  it(
    'answers /api/hiring before our first fetch from the newest readable copy',
    POLLS,
    async () => {
      await poll()
      const c = await asOf('2025-03-10T00:00:00.000Z')
      const hiring = await queryHiring(db, c)
      const mistral = hiring.providers.find((p) => p.provider === 'mistral')!
      expect(mistral).toMatchObject({ feed: 'ok', total: 5 })
      expect(mistral.departments).toEqual([{ department: 'Research', count: 5 }])
      expect(mistral.sources[0]!.source_id).toBe('wayback:mistral-lever-2023')
      expect(hiring.providers.find((p) => p.provider === 'openai')).toMatchObject({
        feed: 'no_rows',
        total: 0,
        sources: [],
      })
      const method = [...c.notes.method].join(' ')
      expect(method).toContain('Internet Archive')
      expect(method).toContain('mistral: Internet Archive copy of 2025-01-08T00:00:00.000Z')
    },
  )

  it('refuses an instant before the earliest readable board', async () => {
    await expect(
      assertArchiveKnowable(db, '2024-12-01T00:00:00.000Z', 'hiring'),
    ).rejects.toBeInstanceOf(PointInTimeError)
    await expect(
      assertArchiveKnowable(db, '2025-01-02T00:00:00.000Z', 'hiring'),
    ).resolves.toBeUndefined()
    // A board copy is not a price list.
    await expect(assertArchiveKnowable(db, '2025-01-02T00:00:00.000Z')).rejects.toBeInstanceOf(
      PointInTimeError,
    )
  })

  it('reports reach and states every gap with what the Archive held', POLLS, async () => {
    await poll()
    const { registry } = await live()
    const reach = (await queryHiringReach(db, registry)).find((r) => r.provider === 'mistral')!
    expect(reach).toMatchObject({
      archived_from: '2025-01-01T00:00:00.000Z',
      archived_until: '2025-04-15T00:00:00.000Z',
      archived_parsed: 3,
      archived_skipped: 1,
    })
    expect(reach.live_from).toMatch(/^2026-09-07T/)
    // The stated gap (Mistral before its first archived board) keeps its own reason, and
    // the rest of the stretch before the first readable copy is computed around it.
    expect(reach.gaps.map((g) => [g.from, g.until])).toEqual([
      ['2023-01-01', '2023-09-27'],
      ['2023-09-27', '2025-01-01'],
      ['2025-01-08', '2025-04-15'],
      ['2025-04-15', '2026-09-07'],
    ])
    expect(reach.gaps[0]!.reason).toContain('Mistral was founded in April 2023')
    expect(reach.gaps[1]!.reason).toContain('first copy we could read is from 2025-01-01')
    expect(reach.gaps[2]!.reason).toContain('couldn’t read the Archive’s 1 copy')
    expect(reach.gaps[2]!.reason).toContain('lever: no postings on the page')
    expect(reach.gaps[3]!.reason).toContain('We read the board live from 2026-09-07')
    const meta = (await queryHiringReach(db, registry)).find((r) => r.provider === 'meta')!
    expect(meta.not_covered).toContain('metacareers.com')
    // The price reach never counts a board copy.
    const prices = (await queryPriceReach(db, registry)).find((r) => r.provider === 'mistral')!
    expect(prices.archived_parsed + prices.archived_skipped).toBe(0)
  })

  it('keeps archived counts CC BY-NC even under a licensee’s key', () => {
    const window = licenseWindow(
      'archived_hiring',
      exportTable('archived_hiring')!,
      { history: 'full' },
      '2026-08-06',
      PAID_LICENSE,
    )
    expect(window.older).toBe(HISTORY_LICENSE)
  })
})
