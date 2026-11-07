import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import figureRowsFixture from '~~/fixtures/reported/gkg-figure-rows.tsv?raw'
import gkgFixture from '~~/fixtures/track-record/gkg-20260929183000.gkg.csv?raw'
import * as schema from '~~/server/db/schema'
import { submitJudgeRun } from '../server/pipeline/judge/submit'
import { amountsIn, figureHeadline, labsIn } from '../server/pipeline/reported/figures'
import {
  applyFigureReadings,
  figureFailure,
  figureReview,
  type JudgeFigure,
} from '../server/pipeline/reported/review'
import {
  articleId,
  figureBackfill,
  recordFigureFile,
  storeFigureRows,
} from '../server/pipeline/reported/store'
import { parseGkgRow } from '../server/pipeline/track-record/gkg'
import { recordGkgFile } from '../server/pipeline/track-record/search'
import { queryContext } from '../server/utils/terminal-db'
import { middle, quarterOf, queryReported } from '../server/utils/terminal-reported'
import { fixtureText } from './pipeline/fixtures'

// Reported figures: the headline matcher, storing figure rows from a GKG file
// (first read and backfill), the judge's gate, and the /revenue payload. No
// network and no model: the rows are real GDELT rows read 2026-11-07 from
// files between 2026-09-04 and 2026-11-02, and the readings are written here.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const NOW = new Date('2026-11-07T12:00:00Z')

const figureRows = figureRowsFixture.split('\n').filter((l) => l.trim())
const articles = figureRows.map((row) => ({ row, article: parseGkgRow(row)! }))
const stampOf = (iso: string) => iso.replace(/[-:TZ]/g, '').slice(0, 14)
/** A file's fixture rows as the job reports them, compacted like a mention. */
const rowsAt = (stamp: string) =>
  articles
    .filter((a) => stampOf(a.article.seen_at) === stamp)
    .map(({ article: { record_id, outlet, url, title } }) => ({ record_id, outlet, url, title }))
const byTitle = (part: string) => articles.find((a) => a.article.title.includes(part))!

async function reset() {
  await db.delete(schema.opsEvents)
  await db.delete(schema.reportedFigures)
  await db.delete(schema.reportedReviews)
  await db.delete(schema.reportedArticles)
  await db.delete(schema.gdeltFiles)
}

/** A file the track record already read, as gdelt_files held it before figures existed. */
async function readBefore(stamp: string, status: 'ok' | 'missing' = 'ok') {
  await db.insert(schema.gdeltFiles).values({
    stamp,
    url: `http://data.gdeltproject.org/gdeltv2/${stamp}.gkg.csv.zip`,
    status,
    rows: 0,
    matched: 0,
    raw_key: null,
    fetched_at: '2026-11-01T00:00:00.000Z',
    recorded_at: '2026-11-01T00:00:00.000Z',
  })
}

/** Every fixture row stored, as the backfill would leave them. */
async function storeAll() {
  const stamps = [...new Set(articles.map((a) => stampOf(a.article.seen_at)))]
  for (const stamp of stamps) {
    await storeFigureRows(db, { stamp, fetched_at: NOW.toISOString(), rows: rowsAt(stamp) }, NOW)
  }
}

beforeEach(reset)

describe('the headline matcher', () => {
  it('reads every amount a headline writes, with its currency and value', () => {
    expect(amountsIn('OpenAI seeks $30bn at a $1.4tn valuation as revenue nears $70bn')).toEqual([
      { text: '$30bn', currency: 'USD', value: 30e9 },
      { text: '$1.4tn', currency: 'USD', value: 1.4e12 },
      { text: '$70bn', currency: 'USD', value: 70e9 },
    ])
    expect(amountsIn('DeepSeek reportedly set to raise more than US$12B ahead of IPO')).toEqual([
      { text: 'US$12B', currency: 'USD', value: 12e9 },
    ])
    expect(amountsIn('Mistral raises €1.7bn, or 2 billion euros by another count')).toEqual([
      { text: '€1.7bn', currency: 'EUR', value: 1.7e9 },
      { text: '2 billion euros', currency: 'EUR', value: 2e9 },
    ])
    expect(amountsIn('Anthropic eyes USD 518 billion AI buildout')[0]).toMatchObject({
      currency: 'USD',
      value: 518e9,
    })
    expect(amountsIn('Anthropic has $40,000,000,000 in the bank')[0]!.value).toBe(40e9)
  })

  it('drops a per-unit price and anything under a million', () => {
    expect(amountsIn('Anthropic makes $2.08 in revenue for every compute dollar')).toEqual([])
    expect(amountsIn('OpenAI offers a $500 bonus')).toEqual([])
  })

  it('names xAI only in its own casing', () => {
    expect(labsIn('xAI raises $20 billion')).toEqual(['xai'])
    expect(labsIn('XAI token rallies')).toEqual([])
    expect(labsIn('OpenAI and Anthropic race to raise')).toEqual(['openai', 'anthropic'])
  })

  it('keeps every fixture headline and none of the track record’s', () => {
    for (const { article } of articles) expect(figureHeadline(article.title)).not.toBeNull()
    for (const row of gkgFixture.split('\n').filter((l) => l.trim())) {
      const article = parseGkgRow(row)
      if (article) expect(figureHeadline(article.title)).toBeNull()
    }
    expect(figureHeadline('OpenAI foundation gifts a cancer center $40 million')).toBeNull()
    expect(figureHeadline('Anthropic revenue grows fast')).toBeNull()
  })
})

describe('storing figure rows', () => {
  it('finds a new file’s figure headlines among the rows it keeps, and marks it read for figures', async () => {
    const stamp = '20261102181500'
    await readBefore('20261102180000')
    const mention = (row: ReturnType<typeof rowsAt>[number]) => ({ ...row, names: ['Anthropic'] })
    const other = { ...rowsAt('20261001160000')[0]!, title: 'Anthropic opens a Tokyo office' }
    const outcome = await recordGkgFile(
      db,
      {
        stamp,
        fetched_at: NOW.toISOString(),
        status: 'ok',
        rows: 1200,
        mentions: [...rowsAt(stamp).map(mention), mention(other)],
      },
      NOW,
    )
    expect(outcome).toMatchObject({ recorded: true, mentions: 3, figures: 2 })
    const [file] = await db
      .select()
      .from(schema.gdeltFiles)
      .where(eq(schema.gdeltFiles.stamp, stamp))
    expect(file!.figures_at).toBe(NOW.toISOString())
    const stored = await db.select().from(schema.reportedArticles)
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatchObject({
      published_at: '2026-11-02T18:15:00.000Z',
      source_url: `http://data.gdeltproject.org/gdeltv2/${stamp}.gkg.csv.zip`,
    })
    expect(stored.map((a) => a.record_id).sort()).toEqual(
      rowsAt(stamp)
        .map((r) => r.record_id)
        .sort(),
    )
  })

  it('backfills a file read before figures existed, once, and skips a missing one', async () => {
    await readBefore('20261009043000')
    await readBefore('20261001160000')
    await readBefore('20261001161500', 'missing')
    expect((await figureBackfill(db)).map((f) => f.stamp)).toEqual([
      '20261001160000',
      '20261009043000',
    ])
    const post = (stamp: string) =>
      recordFigureFile(db, { stamp, fetched_at: NOW.toISOString(), figures: rowsAt(stamp) }, NOW)
    expect(await post('20261001160000')).toEqual({ recorded: true, articles: 1, rejected: 0 })
    expect(await post('20261001160000')).toEqual({ recorded: false, reason: 'not-pending' })
    expect(await post('20261001161500')).toEqual({ recorded: false, reason: 'not-pending' })
    expect(await post('20261104120000')).toEqual({ recorded: false, reason: 'not-pending' })
    expect((await figureBackfill(db)).map((f) => f.stamp)).toEqual(['20261009043000'])
  })

  it('refuses a posted row whose headline is no figure', async () => {
    await readBefore('20261009043000')
    const [row] = rowsAt('20261009043000')
    expect(
      await recordFigureFile(
        db,
        {
          stamp: '20261009043000',
          fetched_at: NOW.toISOString(),
          figures: [row!, { ...row!, url: 'https://example.com/x', title: 'OpenAI hires a CFO' }],
        },
        NOW,
      ),
    ).toEqual({ recorded: true, articles: 1, rejected: 1 })
  })
})

describe('the figure gate', () => {
  const seeks = () => byTitle('OpenAI seeks $30bn')
  const figure = (over: Partial<JudgeFigure>): JudgeFigure => ({
    lab: 'openai',
    metric: 'valuation',
    basis: 'sought',
    amount: '$1.4tn',
    period: null,
    ...over,
  })

  it('offers each headline once, at its earliest copy, with its labs and amounts', async () => {
    await storeAll()
    const review = await figureReview(db)
    expect(review).toHaveLength(articles.length)
    expect(review.map((r) => r.published_at)).toEqual([...review.map((r) => r.published_at)].sort())
    expect(review.find((r) => r.article_id === articleId(seeks().article.url))).toMatchObject({
      labs: ['openai'],
      amounts: [{ text: '$30bn' }, { text: '$1.4tn' }, { text: '$70bn' }],
    })
  })

  it('holds a label only when its lab, amount and period are in the headline', () => {
    const title = seeks().article.title
    expect(figureFailure(title, figure({}))).toBeNull()
    expect(figureFailure(title, figure({ lab: 'anthropic' }))?.reason).toBe('lab-not-in-headline')
    expect(figureFailure(title, figure({ amount: '$1.4 trillion' }))?.reason).toBe(
      'amount-not-in-headline',
    )
    expect(figureFailure(title, figure({ period: '2027' }))?.reason).toBe('period-not-in-headline')
  })

  it('stores a reading once, rejects an invented amount, and records a headline with none', async () => {
    await storeAll()
    const id = articleId(seeks().article.url)
    const gift = articleId(byTitle('SoftBank launches $11 billion').article.url)
    const report = await applyFigureReadings(
      db,
      [
        {
          article_id: id,
          figures: [
            figure({ metric: 'funding', amount: '$30bn' }),
            figure({}),
            figure({ metric: 'revenue_run_rate', basis: 'reported', amount: '$70bn' }),
          ],
        },
        { article_id: gift, figures: [] },
        {
          article_id: articleId(byTitle('Mistral Raises').article.url),
          figures: [figure({ lab: 'mistral', metric: 'funding', amount: '$3.5 billion' })],
        },
        { article_id: 'f'.repeat(64), figures: [] },
      ],
      NOW,
    )
    expect(report.accepted).toBe(2)
    expect(report.inserted).toBe(3)
    expect(report.rejected.map((r) => r.reason)).toEqual([
      'amount-not-in-headline',
      'unknown-article',
    ])
    const rows = await db.select().from(schema.reportedFigures)
    expect(rows.find((r) => r.metric === 'valuation')).toMatchObject({
      lab: 'openai',
      basis: 'sought',
      currency: 'USD',
      amount: 1.4e12,
      amount_text: '$1.4tn',
      published_at: '2026-10-01T16:00:00.000Z',
      source_url: seeks().article.url,
    })
    expect(await db.select().from(schema.reportedReviews)).toHaveLength(2)

    const again = await applyFigureReadings(db, [{ article_id: id, figures: [] }], NOW)
    expect(again).toEqual({ accepted: 0, inserted: 0, rejected: [] })
    expect((await figureReview(db)).map((r) => r.article_id)).not.toContain(id)
  })

  it('takes readings through the judge’s POST body, and refuses a key the contract lacks', async () => {
    await storeAll()
    const id = articleId(seeks().article.url)
    const body = (figures: unknown) =>
      JSON.stringify({
        alerts: [],
        figures,
        judged_through: NOW.toISOString(),
        change_ids_seen: [],
      })
    const ok = await submitJudgeRun(db, body([{ article_id: id, figures: [figure({})] }]), {
      now: NOW,
    })
    expect(ok.figures).toMatchObject({ accepted: 1, inserted: 1 })
    const smuggled = await submitJudgeRun(
      db,
      body([{ article_id: id, figures: [{ ...figure({}), confidence: 0.9 }] }]),
      { now: NOW },
    )
    expect(smuggled.gate_rejection).not.toBeNull()
  })
})

describe('the page payload', () => {
  const ctx = (at: string | null = null) => queryContext(sourcesYaml, null, () => NOW, at)

  it('dates a report by its quarter and takes the middle of its amounts', () => {
    expect(quarterOf('2026-11-02T18:15:00.000Z')).toBe('2026-Q4')
    expect(quarterOf('2026-09-29T16:15:00.000Z')).toBe('2026-Q3')
    expect(middle([20e9, 70e9, 50e9])).toBe(50e9)
    expect(middle([20e9, 70e9])).toBe(45e9)
  })

  it('shows the newest report and a quarter median, kept apart from talks and forecasts', async () => {
    await storeAll()
    await readBefore('20261009091500')
    const runRate = (start: string, amount: string) => ({
      article_id: articleId(byTitle(start).article.url),
      figures: [
        { lab: 'openai', metric: 'revenue_run_rate', basis: 'reported', amount, period: null },
      ] as JudgeFigure[],
    })
    await applyFigureReadings(
      db,
      [
        runRate('annual recurring revenue nears', '$70 billion'),
        runRate('OpenAI seeks $30bn', '$70bn'),
        {
          article_id: articleId(byTitle('DeepSeek reportedly set to raise').article.url),
          figures: [
            { lab: 'deepseek', metric: 'funding', basis: 'sought', amount: 'US$12B', period: null },
          ],
        },
      ],
      new Date('2026-11-05T00:00:00Z'),
    )

    const data = await queryReported(db, ctx())
    expect(data.series).toHaveLength(1)
    const [openai] = data.series
    expect(openai).toMatchObject({ lab: 'openai', metric: 'revenue_run_rate', currency: 'USD' })
    expect(openai!.latest.published_at).toBe('2026-10-01T16:00:00.000Z')
    expect(openai!.quarters).toEqual([
      { quarter: '2026-Q4', median: 70e9, low: 70e9, high: 70e9, reports: 1 },
      { quarter: '2026-Q3', median: 70e9, low: 70e9, high: 70e9, reports: 1 },
    ])
    expect(data.recent.map((h) => h.basis)).toEqual(['sought', 'reported', 'reported'])
    expect(data.coverage).toMatchObject({ files_waiting: 1, unread: articles.length - 3 })

    const before = await queryReported(db, ctx('2026-11-04T00:00:00.000Z'))
    expect(before.series).toEqual([])
    expect(before.coverage.unread).toBe(0)
  })
})
