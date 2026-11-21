import { beforeEach, describe, expect, it } from 'vitest'

import {
  ARCHIVE_FROM,
  archiveWork,
  fillDays,
  fillStamps,
  hotDays,
  inArchive,
  passOf,
  recordArchiveFile,
  scoutStamps,
} from '../server/pipeline/reported/archive'
import { figureReview } from '../server/pipeline/reported/review'
import { storeFigureRows, titleKey } from '../server/pipeline/reported/store'

// The archive of GKG files before GKG_FROM: which files the Worker hands out
// (scout every hour, then fill the days with figure headlines), what it keeps
// of one, and where its headlines wait in the judge's queue. The headlines are
// as GDELT carried them on 2025-03-03 (read 2026-11-20); outlets and URLs are
// placeholders.

const NOW = new Date('2026-11-21T12:00:00Z')

const row = (title: string, n: number) => ({
  record_id: `20250303180000-${n}`,
  outlet: 'example.com',
  url: `https://example.com/a/${n}`,
  title,
})
const SERIES_E = row('AI firm Anthropic valued at $61.5 bn in funding round', 1)
const SERIES_E_TOO = row('Anthropic raises $3.5B to fuel its AI ambitions', 2)
const RUN_RATE = row('Anthropic hits $3 billion in annualized revenue on business demand for AI', 3)
const NO_FIGURE = row('Anthropic opens a Tokyo office', 4)

const article = (published_at: string, title: string) => ({
  published_at,
  title_key: titleKey(title),
  title,
})

async function reset() {
  await db.delete(schema.reportedReviews)
  await db.delete(schema.reportedArticles)
  await db.delete(schema.gdeltArchiveFiles)
  await db.delete(schema.gkgMentions)
  await db.delete(schema.gdeltFiles)
}

const post = (stamp: string, figures = [SERIES_E], status: 'ok' | 'missing' = 'ok') =>
  recordArchiveFile(db, { stamp, fetched_at: NOW.toISOString(), status, rows: 1_900, figures }, NOW)

beforeEach(reset)

describe('the archive’s files', () => {
  it('reads an hour’s first quarter hour in the scout and the rest in the fill', () => {
    expect(passOf('20250303180000')).toBe('scout')
    expect(passOf('20250303181500')).toBe('fill')
  })

  it('takes only quarter hours from ARCHIVE_FROM up to GKG_FROM', () => {
    expect(ARCHIVE_FROM).toBe('2023-01-01T00:00:00.000Z')
    expect(inArchive('20230101000000')).toBe(true)
    expect(inArchive('20260831234500')).toBe(true)
    expect(inArchive('20260901000000')).toBe(false)
    expect(inArchive('20221231234500')).toBe(false)
    expect(inArchive('20250303181000')).toBe(false)
    expect(inArchive('20250230180000')).toBe(false)
  })

  it('scouts every hour, oldest first, and stops before GKG_FROM', () => {
    expect(scoutStamps(null, 3)).toEqual(['20230101000000', '20230101010000', '20230101020000'])
    expect(scoutStamps('20250303230000', 2)).toEqual(['20250304000000', '20250304010000'])
    expect(scoutStamps('20260831220000', 5)).toEqual(['20260831230000'])
    expect(scoutStamps('20260831230000', 5)).toEqual([])
  })

  it('fills a day when its scout files carry two headlines, or one stating revenue', () => {
    const articles = [
      article('2025-03-03T18:00:00.000Z', SERIES_E.title),
      article('2025-03-03T21:00:00.000Z', SERIES_E_TOO.title),
      // The same headline twice is one headline.
      article('2025-04-10T09:00:00.000Z', SERIES_E.title),
      article('2025-04-10T10:00:00.000Z', SERIES_E.title),
      article('2025-05-30T20:00:00.000Z', RUN_RATE.title),
      // A fill file's headline doesn't make its day hot, so the fill can't widen itself.
      article('2025-06-02T18:15:00.000Z', SERIES_E.title),
      article('2025-06-02T18:30:00.000Z', SERIES_E_TOO.title),
      // From GKG_FROM on, the live files hold the day.
      article('2026-09-02T18:00:00.000Z', SERIES_E.title),
      article('2026-09-02T19:00:00.000Z', SERIES_E_TOO.title),
    ]
    expect(hotDays(articles)).toEqual(['2025-03-03', '2025-05-30'])
  })

  it('fills the day either side of a hot one, inside the archive', () => {
    expect(fillDays(['2025-03-03', '2025-03-04'])).toEqual([
      '2025-03-02',
      '2025-03-03',
      '2025-03-04',
      '2025-03-05',
    ])
    expect(fillDays(['2023-01-01', '2026-08-31'])).toEqual([
      '2023-01-01',
      '2023-01-02',
      '2026-08-30',
      '2026-08-31',
    ])
  })

  it('fills the 72 quarter hours the scout skipped, after the last one read', () => {
    const day = fillStamps(['2025-03-03'], null, 1_000)
    expect(day).toHaveLength(72)
    expect(day.slice(0, 4)).toEqual([
      '20250303001500',
      '20250303003000',
      '20250303004500',
      '20250303011500',
    ])
    expect(day.every((s) => passOf(s) === 'fill')).toBe(true)
    expect(fillStamps(['2025-03-02', '2025-03-03'], '20250302234500', 2)).toEqual([
      '20250303001500',
      '20250303003000',
    ])
  })
})

describe('the Worker’s archive queue', () => {
  it('hands out the scout until it reaches GKG_FROM, then fills the hot days', async () => {
    expect((await archiveWork(db, 2)).map((f) => f.stamp)).toEqual([
      '20230101000000',
      '20230101010000',
    ])
    expect(await post('20250303180000', [SERIES_E, SERIES_E_TOO])).toEqual({
      recorded: true,
      articles: 2,
      rejected: 0,
    })
    // The scout's last file read: every day has been scouted.
    await post('20260831230000', [], 'missing')
    expect(await archiveWork(db, 2)).toEqual([
      {
        stamp: '20250302001500',
        url: 'http://data.gdeltproject.org/gdeltv2/20250302001500.gkg.csv.zip',
      },
      {
        stamp: '20250302003000',
        url: 'http://data.gdeltproject.org/gdeltv2/20250302003000.gkg.csv.zip',
      },
    ])
    await post('20250304234500', [])
    expect(await archiveWork(db, 2)).toEqual([])
  })

  it('keeps a file’s figure headlines once, and nothing an alert could match', async () => {
    expect(await post('20250303180000', [SERIES_E, NO_FIGURE])).toEqual({
      recorded: true,
      articles: 1,
      rejected: 1,
    })
    expect(await post('20250303180000')).toEqual({ recorded: false, reason: 'already-read' })
    expect(await post('20261102180000')).toEqual({ recorded: false, reason: 'outside-archive' })
    expect(await post('20250303181500', [RUN_RATE], 'missing')).toMatchObject({ articles: 0 })

    const files = await db.select().from(schema.gdeltArchiveFiles)
    expect(files.map((f) => [f.stamp, f.pass, f.status, f.rows, f.figures])).toEqual([
      ['20250303180000', 'scout', 'ok', 1_900, 1],
      ['20250303181500', 'fill', 'missing', 0, 0],
    ])
    const [stored] = await db.select().from(schema.reportedArticles)
    expect(stored).toMatchObject({
      title: SERIES_E.title,
      published_at: '2025-03-03T18:00:00.000Z',
      found_at: NOW.toISOString(),
      source_url: 'http://data.gdeltproject.org/gdeltv2/20250303180000.gkg.csv.zip',
    })
    expect(await db.select().from(schema.gkgMentions)).toEqual([])
    expect(await db.select().from(schema.gdeltFiles)).toEqual([])
  })
})

describe('the judge’s queue', () => {
  it('offers the live headlines before the archive’s, however old', async () => {
    const live = row('OpenAI raises $40 billion at a $300 billion valuation', 9)
    await storeFigureRows(
      db,
      { stamp: '20261102180000', fetched_at: NOW.toISOString(), rows: [live] },
      NOW,
    )
    await post('20250303180000', [SERIES_E])
    expect((await figureReview(db)).map((r) => r.title)).toEqual([live.title, SERIES_E.title])
  })
})
