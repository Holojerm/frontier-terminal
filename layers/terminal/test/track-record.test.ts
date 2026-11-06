import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import gdeltFixture from '~~/fixtures/track-record/gdelt-gpt-6.1-sol.json?raw'
import deepmindFeed from '~~/fixtures/recipes/newsroom-google-deepmind.xml?raw'
import metaFeed from '~~/fixtures/recipes/newsroom-meta.xml?raw'
import mistralFeed from '~~/fixtures/recipes/newsroom-mistral.xml?raw'
import openaiFeed from '~~/fixtures/recipes/newsroom-openai.xml?raw'
import * as schema from '~~/server/db/schema'
import { contentHash, type ChangeRow } from '../server/pipeline/contracts'
import { groundingFailure } from '../server/pipeline/judge/grounding'
import { submitJudgeRun } from '../server/pipeline/judge/submit'
import { insertRows } from '../server/pipeline/store'
import {
  GDELT_MAX_RECORDS,
  PRESS_CANDIDATE_LIMIT,
  candidateTitle,
  gdeltStamp,
  gdeltUrl,
  parseGdeltArticles,
  untokenizeTitle,
} from '../server/pipeline/track-record/gdelt'
import {
  applyTrackRecordVerdicts,
  pendingCandidates,
  reviewCorpus,
  trackRecordReview,
} from '../server/pipeline/track-record/review'
import {
  GDELT_PENDING_LIMIT,
  MAX_FAILED_SEARCHES,
  candidateId,
  dueGdeltSearches,
  recordGdeltResult,
  runTrackRecordSearch,
  transientSearch,
  type GdeltAnswer,
} from '../server/pipeline/track-record/search'
import {
  alertTerms,
  filerName,
  gdeltQuery,
  matchesWhat,
  modelFamily,
} from '../server/pipeline/track-record/terms'
import {
  leadHours,
  median,
  sawIt,
  searchState,
  trackWindow,
} from '../server/pipeline/track-record/window'
import { NEWSROOM_FROM, extractNewsroom } from '../server/theses/recipes/newsrooms'
import { queryContext } from '../server/utils/terminal-db'
import { queryTrackRecord, sideOf, tally } from '../server/utils/terminal-track-record'
import { fixtureText } from './pipeline/fixtures'

// The track record: deterministic search terms from the cited change rows,
// the window around the saw-it time, the GDELT and newsroom readers, the
// search run against a real D1 with a canned fetcher, and the gate on the
// judge's same-event ratings. No network and no model: GDELT's answer is a
// committed fixture, and the ratings are written here.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')

const HASH = (n: number) => n.toString(16).padStart(64, '0')

function change(over: Partial<ChangeRow> & { after?: object; before?: object }): ChangeRow {
  const { after, before, ...rest } = over
  const change_type = rest.change_type ?? (before && !after ? 'removed' : 'added')
  return {
    id: HASH(Math.floor(Math.random() * 1e12)),
    entity_key: 'model:openai:gpt-6.1-sol:standard',
    entity_type: 'model',
    provider: 'openai',
    change_type,
    before_hash: change_type === 'added' ? null : HASH(1),
    after_hash: change_type === 'removed' ? null : HASH(2),
    before_json: before ? JSON.stringify(before) : null,
    after_json: after ? JSON.stringify(after) : null,
    detected_at: '2026-09-29T17:01:00.000Z',
    source_url: 'https://developers.openai.com/api/docs/models.md',
    fetched_at: '2026-09-29T17:01:00.000Z',
    ...rest,
  }
}

describe('search terms', () => {
  it('reads a model family the way the press writes it', () => {
    expect(modelFamily('gpt-6.1-sol')).toBe('gpt 6.1')
    expect(modelFamily('claude-sonnet-5-5')).toBe('claude sonnet 5.5')
    expect(modelFamily('claude-haiku-5-5-(for-prompts-over-100,000-tokens)')).toBe(
      'claude haiku 5.5',
    )
    expect(modelFamily('gemini-3.5-flash-lite')).toBe('gemini 3.5')
    expect(modelFamily('gemini-2.5-computer-use-preview-10-2025')).toBe('gemini 2.5')
    expect(modelFamily('claude-opus-4-20250514')).toBe('claude opus 4')
    expect(modelFamily('grok-4.7')).toBe('grok 4.7')
    expect(modelFamily('gemini-omni-flash-preview')).toBe('gemini omni flash')
    expect(modelFamily('')).toBeNull()
  })

  it('cleans a filer name and prefers the press name for a whitelisted CIK', () => {
    expect(filerName('AMAZON COM INC')).toBe('AMAZON')
    expect(filerName('Anthropic, PBC  (CIK 0002130357)')).toBe('Anthropic')
    const filing = change({
      entity_type: 'filing',
      provider: 'other',
      entity_key: 'filing:0001104659-26-118614',
      after: {
        display_names: ['SPACE EXPLORATION TECHNOLOGIES CORP'],
        form: '8-K',
        whitelist_cik: '0001181412',
      },
    })
    expect(alertTerms([filing])).toEqual({ who: ['SpaceX'], what: ['8-K', 'filing'], also: [] })
  })

  it('builds the same query from the same rows, whatever their order', () => {
    const a = change({ after: { model_slug: 'gpt-6.1-sol' } })
    const b = change({ after: { model_slug: 'gpt-6-astra' } })
    expect(gdeltQuery(alertTerms([a, b])!)).toBe('("gpt 6.1" OR "gpt 6") sourcelang:english')
    expect(alertTerms([b, a])!.what.sort()).toEqual(alertTerms([a, b])!.what.sort())
  })

  it('pairs a department with hiring words, and an incident with outage words', () => {
    const job = change({
      entity_type: 'job',
      entity_key: 'job:openai:x',
      after: { title: 'Head of Marketing Technology (MarTech)', department: 'Marketing' },
    })
    expect(gdeltQuery(alertTerms([job])!)).toBe(
      'OpenAI Marketing (hiring OR jobs OR "job cuts" OR layoffs OR roles) sourcelang:english',
    )
    const incident = change({
      entity_type: 'incident',
      provider: 'anthropic',
      entity_key: 'incident:anthropic:x',
      after: { title: 'Elevated errors for Claude Sonnet 5.5' },
    })
    expect(gdeltQuery(alertTerms([incident])!)).toBe(
      '(Anthropic OR Claude) (outage OR outages OR "elevated errors" OR disruption) sourcelang:english',
    )
  })

  it('times a fact by the form it was read from', () => {
    const revenue = change({
      entity_type: 'revenue',
      provider: 'anthropic',
      entity_key: 'revenue:x',
      after: { entity_name: 'Anthropic, PBC', form: 'S-1/A (Amendment No. 1)' },
    })
    expect(alertTerms([revenue])!.what).toContain('IPO')
    const quarterly = change({
      entity_type: 'revenue',
      provider: 'xai',
      entity_key: 'revenue:y',
      after: { entity_name: 'Space Exploration Technologies Corp.', form: '10-Q' },
    })
    expect(alertTerms([quarterly])!.what).toContain('earnings')
  })

  it('has no terms for a row with no press shape', () => {
    expect(alertTerms([change({ entity_type: 'ranking', after: {} })])).toBeNull()
  })

  it('matches a newsroom post on whole words, with versions read alike', () => {
    const terms = { who: [], what: ['gpt 6.1'], also: [] }
    expect(matchesWhat('Introducing GPT‑6.1 Sol.', terms)).toBe(true)
    expect(matchesWhat('GPT-6.15 is here', terms)).toBe(false)
    expect(matchesWhat('gpt 6.1', { ...terms, what: ['claude sonnet 5.5'] })).toBe(false)
  })
})

describe('the window', () => {
  it('counts from the earliest fetch, and a removal from when we noticed it', () => {
    const added = change({
      fetched_at: '2026-10-02T06:00:00.000Z',
      detected_at: '2026-10-02T06:00:00.000Z',
    })
    const removed = change({
      change_type: 'removed',
      before: { model_slug: 'sora-2' },
      // The last fetch that still listed it, weeks before the removal.
      fetched_at: '2026-09-01T00:00:00.000Z',
      detected_at: '2026-10-01T12:00:00.000Z',
    })
    expect(sawIt([added, removed])).toMatchObject({
      at: '2026-10-01T12:00:00.000Z',
      change_id: removed.id,
    })
    expect(sawIt([])).toBeNull()
  })

  it('spans 7 days either side, opens for search once it closes, and stops at GDELT’s horizon', () => {
    const w = trackWindow('2026-10-01T12:00:00.000Z')
    expect(w).toEqual({ start: '2026-09-24T12:00:00.000Z', end: '2026-10-08T12:00:00.000Z' })
    expect(searchState(w, new Date('2026-10-08T11:59:00Z'))).toBe('open')
    expect(searchState(w, new Date('2026-10-08T12:00:00Z'))).toBe('due')
    expect(searchState(w, new Date('2026-12-24T00:00:00Z'))).toBe('beyond-horizon')
  })

  it('signs a lead positive when we saw it first, and takes a median', () => {
    expect(leadHours('2026-09-29T17:01:00Z', '2026-09-29T18:30:00Z')).toBe(1.5)
    expect(leadHours('2026-09-29T17:01:00Z', '2026-09-29T15:01:00Z')).toBe(-2)
    expect(median([3, -1, 10])).toBe(3)
    expect(median([1, 2])).toBe(1.5)
    expect(median([])).toBeNull()
  })
})

describe('GDELT', () => {
  it('asks for the window in GDELT’s UTC format, earliest first', () => {
    expect(gdeltStamp('2026-10-01T12:30:05.123Z')).toBe('20261001123005')
    const url = new URL(
      gdeltUrl('"gpt 6.1" sourcelang:english', '2026-09-22T17:01:00Z', '2026-10-06T17:01:00Z'),
    )
    expect(url.origin + url.pathname).toBe('https://api.gdeltproject.org/api/v2/doc/doc')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: '"gpt 6.1" sourcelang:english',
      mode: 'artlist',
      format: 'json',
      sort: 'dateasc',
      maxrecords: String(GDELT_MAX_RECORDS),
      startdatetime: '20260922170100',
      enddatetime: '20261006170100',
    })
  })

  it('reads articles earliest first, one per headline, with GDELT’s seen time', () => {
    const articles = parseGdeltArticles(gdeltFixture)
    expect(articles.length).toBeGreaterThan(0)
    expect(articles.length).toBeLessThanOrEqual(PRESS_CANDIDATE_LIMIT)
    expect(articles[0]).toMatchObject({ outlet: 'cnet.com', seen_at: '2026-09-29T18:30:00.000Z' })
    const titles = articles.map((a) => a.title.toLowerCase())
    expect(new Set(titles).size).toBe(titles.length)
    const times = articles.map((a) => a.seen_at)
    expect([...times].sort()).toEqual(times)
  })

  it('stores a title with GDELT’s tokenizing spaces closed', () => {
    expect(parseGdeltArticles(gdeltFixture)[0]!.title).toBe(
      'OpenAI DevDay: You Can Now Use GPT - 6.1 Sol and Dots, Plus Big Subscription Changes',
    )
  })

  // Titles as production D1 held them on 2026-11-05.
  it.each([
    [
      'Grok 4 . 7 arrives for coding and knowledge work at Grok 4 . 6 prices · Digg',
      'Grok 4.7 arrives for coding and knowledge work at Grok 4.6 prices · Digg',
    ],
    [
      'Mapping Precision : GPT Image 2 . 5 Solves Spatial Data - GIS user technology news',
      'Mapping Precision: GPT Image 2.5 Solves Spatial Data - GIS user technology news',
    ],
    [
      'Did You Lose Money on Alphabet Inc . ( GOOGL )? Levi & Korsinsky Urges ...',
      'Did You Lose Money on Alphabet Inc. (GOOGL)? Levi & Korsinsky Urges ...',
    ],
    [
      '4 , 058 Alphabet Inc . $GOOGL Shares Sold by SFM LLC',
      '4,058 Alphabet Inc. $GOOGL Shares Sold by SFM LLC',
    ],
    [
      'Meta Platforms ( NASDAQ : META ) Trading 11 . 3 % Higher – Still a Buy ?',
      'Meta Platforms (NASDAQ: META) Trading 11.3% Higher – Still a Buy?',
    ],
    [
      'OpenAI releases ChatGPT Images 2 . 5 with  sharper detail',
      'OpenAI releases ChatGPT Images 2.5 with sharper detail',
    ],
    ['Gartner $2 . 67 trillion', 'Gartner $2.67 trillion'],
    ['Pixel Scroll 9 / 21 / 26 And May', 'Pixel Scroll 9/21/26 And May'],
    // Not a thousands separator, so not one number; a hyphen stays as GDELT wrote it.
    ['Ranked 1 , 2 and 3', 'Ranked 1, 2 and 3'],
    ['state - level hacking', 'state - level hacking'],
  ])('untokenizes %j', (raw, clean) => {
    expect(untokenizeTitle(raw)).toBe(clean)
    expect(untokenizeTitle(clean)).toBe(clean)
  })

  it('reads an empty result as none, and refuses a plain-text answer', () => {
    expect(parseGdeltArticles('{}')).toEqual([])
    expect(() => parseGdeltArticles('Please limit requests to one every 5 seconds')).toThrow(
      'not JSON',
    )
  })
})

describe('newsroom feeds', () => {
  // Each fixture is the feed's newest posts plus its oldest; Meta's feed holds only ten, all recent.
  it.each([
    ['openai', openaiFeed, 5],
    ['google-deepmind', deepmindFeed, 5],
    ['meta', metaFeed, 6],
    ['mistral', mistralFeed, 5],
  ])('%s: keeps posts from NEWSROOM_FROM on, with their exact time', (_, feed, kept) => {
    const posts = extractNewsroom(feed)
    expect(posts.length).toBe(kept)
    for (const p of posts) {
      expect(p.date >= NEWSROOM_FROM).toBe(true)
      expect(p.payload.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(String(p.payload.title)).not.toMatch(/CDATA|<|&amp;/)
      expect(String(p.payload.link)).toMatch(/^https:\/\//)
    }
  })

  it('throws on something that is not RSS', () => {
    expect(() => extractNewsroom('<html></html>')).toThrow('not an RSS feed')
  })
})

// ---- against D1 ----------------------------------------------------------------

const SAW = '2026-09-29T17:01:00.000Z'
const NOW = new Date('2026-11-04T12:00:00Z')

const launch = change({
  id: HASH(101),
  after: { model_slug: 'gpt-6.1-sol', tier: 'standard', input_per_mtok: 2, output_per_mtok: 10 },
})
const fresh = change({
  id: HASH(102),
  entity_key: 'model:openai:gpt-6.1-terra:standard',
  after: { model_slug: 'gpt-6.1-terra' },
  detected_at: '2026-11-01T21:30:00.000Z',
  fetched_at: '2026-11-01T21:30:00.000Z',
})

const alertRow = (id: number, c: ChangeRow, severity = 'notable') => ({
  id: HASH(id),
  severity,
  headline: `OpenAI lists a new model, ${JSON.parse(c.after_json!).model_slug}`,
  explanation: 'A new SKU.',
  change_ids: JSON.stringify([c.id]),
  rule: 'model-floor',
  created_at: c.fetched_at,
  source_url: c.source_url,
  fetched_at: c.fetched_at,
})

const memoryRaw = () => {
  const put: string[] = []
  return { put, store: { put: async (key: string) => void put.push(key) } }
}

async function seed() {
  await db.delete(schema.opsEvents)
  await db.delete(schema.trackRecordVerdicts)
  await db.delete(schema.trackRecordCandidates)
  await db.delete(schema.trackRecordSearches)
  await db.delete(schema.alerts)
  await db.delete(schema.changes)
  await db.delete(schema.recipeObservations)
  await insertRows(db, 'changes', [launch, fresh])
  await db
    .insert(schema.alerts)
    .values([alertRow(1, launch), alertRow(2, fresh), alertRow(3, launch, 'info')])
  await db.insert(schema.recipeObservations).values({
    id: HASH(900),
    recipe_id: 'newsroom-openai',
    company: 'openai',
    key: 'https://openai.com/index/gpt-6-1',
    date: '2026-09-29',
    value: null,
    payload: JSON.stringify({
      title: 'Introducing GPT-6.1 Sol',
      link: 'https://openai.com/index/gpt-6-1',
      published_at: '2026-09-29T17:00:00.000Z',
      summary: 'Our newest model.',
    }),
    raw_key: 'recipes/newsroom-openai/x.xml',
    first_seen_at: '2026-09-29T18:00:00.000Z',
    source_url: 'https://openai.com/news/rss.xml',
    fetched_at: '2026-09-29T18:00:00.000Z',
  })
}

const OK: GdeltAnswer = { kind: 'http', status: 200, text: gdeltFixture }

/** One hourly Actions run: the cron's half, then each due GDELT search answered with `answer`. */
async function searchAll(answer: GdeltAnswer = OK, raw = memoryRaw()) {
  await runTrackRecordSearch(db, { now: () => NOW })
  const due = await dueGdeltSearches(db, NOW)
  const outcomes: Awaited<ReturnType<typeof recordGdeltResult>>[] = []
  for (const d of due) {
    const outcome = await recordGdeltResult(
      db,
      raw.store,
      { alert_id: d.alert_id, url: d.url, fetched_at: NOW.toISOString(), answer },
      NOW,
    )
    outcomes.push(outcome)
    if (outcome.recorded && outcome.transient) break
  }
  return { due, outcomes }
}

describe('the search run', () => {
  beforeEach(seed)

  it('hands out each material alert once its window has closed, and only those', async () => {
    const raw = memoryRaw()
    const { due, outcomes } = await searchAll(OK, raw)
    // The info alert is not material; the 2026-11-01 alert's window is still open.
    expect(due).toHaveLength(1)
    expect(due[0]!.alert_id).toBe(HASH(1))
    expect(new URL(due[0]!.url).searchParams.get('query')).toBe('"gpt 6.1" sourcelang:english')
    expect(outcomes[0]).toMatchObject({ recorded: true, status: 'ok', transient: false })
    expect(raw.put).toHaveLength(1)

    const candidates = await db.select().from(schema.trackRecordCandidates)
    expect(candidates.every((c) => c.alert_id === HASH(1))).toBe(true)
    const newsroom = candidates.filter((c) => c.kind === 'newsroom')
    expect(newsroom).toHaveLength(1)
    expect(newsroom[0]).toMatchObject({
      outlet: 'openai.com',
      published_at: '2026-09-29T17:00:00.000Z',
    })
    const press = candidates.filter((c) => c.kind === 'press')
    expect(press.length).toBeGreaterThan(0)
    expect(
      press.every((c) => c.source_url === due[0]!.url && c.fetched_at === NOW.toISOString()),
    ).toBe(true)

    // A second run has nothing left to do.
    expect(await dueGdeltSearches(db, NOW)).toHaveLength(0)
    expect(await runTrackRecordSearch(db, { now: () => NOW })).toMatchObject({
      newsroom: 0,
      skipped: 0,
    })
  })

  it('the cron fetches nothing: it writes the newsroom side and leaves GDELT due', async () => {
    const report = await runTrackRecordSearch(db, { now: () => NOW })
    expect(report).toMatchObject({ newsroom: 1, candidates: 1 })
    const searches = await db.select().from(schema.trackRecordSearches)
    expect(searches.map((s) => s.source)).toEqual(['newsroom'])
    expect(await dueGdeltSearches(db, NOW)).toHaveLength(1)
  })

  it('caps what one run hands out', async () => {
    expect(GDELT_PENDING_LIMIT).toBeGreaterThan(0)
    expect(await dueGdeltSearches(db, NOW, 0)).toHaveLength(0)
  })

  it('refuses an answer for a search that is not due, or at another URL', async () => {
    const [due] = await dueGdeltSearches(db, NOW)
    const post = (alert_id: string, url: string) =>
      recordGdeltResult(
        db,
        memoryRaw().store,
        { alert_id, url, fetched_at: NOW.toISOString(), answer: OK },
        NOW,
      )
    // The window of alert 2 is still open; alert 3 is not material.
    expect(await post(HASH(2), due!.url)).toEqual({ recorded: false, reason: 'not-due' })
    expect(await post(HASH(3), due!.url)).toEqual({ recorded: false, reason: 'not-due' })
    const other = due!.url.replace('gpt+6.1', 'something+else')
    expect(await post(HASH(1), other)).toEqual({ recorded: false, reason: 'url-mismatch' })
    expect(await db.select().from(schema.trackRecordSearches)).toHaveLength(0)

    expect(await post(HASH(1), due!.url)).toMatchObject({ recorded: true, status: 'ok' })
    expect(await post(HASH(1), due!.url)).toEqual({ recorded: false, reason: 'not-due' })
  })

  it('records a 429 or a timeout as busy: not mailed, retried on the next run', async () => {
    for (const busy of [
      { kind: 'http', status: 429, text: 'slow down' },
      { kind: 'timeout' },
    ] as GdeltAnswer[]) {
      await seed()
      const { outcomes } = await searchAll(busy)
      expect(outcomes[0]).toMatchObject({ recorded: true, status: 'failed', transient: true })
      expect(await db.select().from(schema.opsEvents)).toHaveLength(0)
      expect(await dueGdeltSearches(db, NOW)).toHaveLength(1)
    }
  })

  it('never gives an alert up over 429s or timeouts, only over real failures', async () => {
    for (let i = 0; i < MAX_FAILED_SEARCHES + 2; i++) {
      await searchAll({ kind: 'http', status: 429, text: '' })
      await searchAll({ kind: 'timeout' })
    }
    expect(await dueGdeltSearches(db, NOW)).toHaveLength(1)

    await seed()
    for (let i = 0; i < MAX_FAILED_SEARCHES; i++) {
      await searchAll({ kind: 'http', status: 500, text: 'oops' })
    }
    expect(await dueGdeltSearches(db, NOW)).toHaveLength(0)
    const events = await db.select().from(schema.opsEvents)
    expect(events).toHaveLength(MAX_FAILED_SEARCHES)
    expect(events[0]!.kind).toBe('track_record_search_failed')
  })

  it('reads the timeouts the Worker’s own fetcher wrote as busy too', () => {
    const failed = (detail: string) => ({ status: 'failed', detail })
    expect(
      transientSearch(
        failed(
          'fetch threw: TimeoutError: The operation was aborted due to timeout after 1 attempts',
        ),
      ),
    ).toBe(true)
    expect(transientSearch(failed('HTTP 429 (Retry-After 60s)'))).toBe(true)
    expect(transientSearch(failed('timeout: GDELT did not answer in time'))).toBe(true)
    expect(transientSearch(failed('HTTP 500'))).toBe(false)
    expect(transientSearch(failed('parse: SyntaxError'))).toBe(false)
    expect(transientSearch({ status: 'ok', detail: null })).toBe(false)
  })
})

describe('the same-event gate', () => {
  beforeEach(async () => {
    await seed()
    await searchAll()
  })

  it('offers candidates earliest first, and none after the first one rated the same event', () => {
    const c = (id: number, at: string) =>
      ({ id: HASH(id), alert_id: 'a', kind: 'press', published_at: at }) as never
    const all = [c(1, '2026-10-01'), c(2, '2026-10-02'), c(3, '2026-10-03'), c(4, '2026-10-04')]
    expect(pendingCandidates(all, []).map((x: { id: string }) => x.id)).toEqual(
      [1, 2, 3, 4].map(HASH),
    )
    const rated = [
      { candidate_id: HASH(1), same_event: false },
      { candidate_id: HASH(3), same_event: true },
    ]
    expect(pendingCandidates(all, rated).map((x: { id: string }) => x.id)).toEqual([HASH(2)])
  })

  it('puts the alert, its change rows and its unrated candidates in the review block', async () => {
    const review = await trackRecordReview(db)
    expect(review).toHaveLength(1)
    expect(review[0]!.alert_id).toBe(HASH(1))
    expect(review[0]!.changes.map((c) => c.id)).toEqual([launch.id])
    expect(review[0]!.candidates.length).toBeGreaterThan(0)
  })

  it('stores a grounded rating once, and rejects an unknown candidate or an invented number', async () => {
    const first = (await trackRecordReview(db))[0]!.candidates.find((c) => c.kind === 'press')!
    const report = await applyTrackRecordVerdicts(
      db,
      [
        {
          candidate_id: first.candidate_id,
          same_event: true,
          rationale: 'The headline reports gpt-6.1-sol, the model the alert lists.',
        },
        { candidate_id: HASH(4242), same_event: true, rationale: 'Same launch.' },
        { candidate_id: first.candidate_id, same_event: true, rationale: 'Priced at 7 per MTok.' },
      ],
      NOW,
    )
    expect(report.accepted).toBe(1)
    expect(report.inserted).toBe(1)
    expect(report.rejected.map((r) => r.reason).sort()).toEqual([
      'ungrounded-number',
      'unknown-candidate',
    ])
    const again = await applyTrackRecordVerdicts(
      db,
      [{ candidate_id: first.candidate_id, same_event: false, rationale: 'Another story.' }],
      NOW,
    )
    expect(again.inserted).toBe(0)
  })

  it('grounds a version against a press title stored before ingest untokenized it', () => {
    const alert = { headline: 'xAI launches grok-4.7', explanation: '' }
    const stored = {
      title: 'Grok 4 . 7 arrives for coding and knowledge work at Grok 4 . 6 prices · Digg',
      snippet: null,
      outlet: 'digg.com',
      published_at: '2026-10-30T00:00:00.000Z',
    }
    const rationale = 'Reports the "Grok 4.7" launch at Grok 4.6 prices.'
    const corpus = reviewCorpus({ ...stored, kind: 'press' }, alert, [])
    expect(groundingFailure(rationale, corpus)).toBeNull()
    // A lab's own feed title is shown as written.
    expect(candidateTitle({ kind: 'newsroom', title: stored.title })).toBe(stored.title)
  })

  it('takes ratings through the judge’s POST body, and refuses a key the contract lacks', async () => {
    const [press] = (await trackRecordReview(db))[0]!.candidates
    const body = (track_record: unknown) =>
      JSON.stringify({
        alerts: [],
        track_record,
        judged_through: SAW,
        change_ids_seen: [],
      })
    const ok = await submitJudgeRun(
      db,
      body([
        {
          candidate_id: press!.candidate_id,
          same_event: false,
          rationale: 'A roundup of the week.',
        },
      ]),
      { now: NOW },
    )
    expect(ok.track_record).toMatchObject({ accepted: 1, inserted: 1 })
    const smuggled = await submitJudgeRun(
      db,
      body([
        { candidate_id: press!.candidate_id, same_event: true, rationale: 'x', lead_hours: 9 },
      ]),
      { now: NOW },
    )
    expect(smuggled.gate_rejection).not.toBeNull()
  })
})

describe('the page payload', () => {
  beforeEach(async () => {
    await seed()
    await searchAll()
  })

  const ctx = (at: string | null = null) => queryContext(sourcesYaml, null, () => NOW, at)

  it('says "not yet rated" until the earliest candidates are rated, never a guessed lead', async () => {
    const data = await queryTrackRecord(db, ctx())
    expect(data.rows.map((r) => r.alert_id)).toEqual([HASH(2), HASH(1)])
    const [open, searched] = data.rows
    expect(open!.press.state).toBe('window-open')
    expect(searched!.saw_at).toBe(SAW)
    expect(searched!.press).toMatchObject({ state: 'not-yet-rated', lead_hours: null, hit: null })
    expect(data.press.matched).toBe(0)
  })

  it('shows the first same-event report with its lead, and tallies leads and lags', async () => {
    const candidates = await db.select().from(schema.trackRecordCandidates)
    const press = candidates
      .filter((c) => c.kind === 'press')
      .sort((a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id))
    const newsroom = candidates.find((c) => c.kind === 'newsroom')!
    await applyTrackRecordVerdicts(
      db,
      [
        {
          candidate_id: press[0]!.id,
          same_event: true,
          rationale: 'Reports the gpt-6.1-sol launch.',
        },
        { candidate_id: newsroom.id, same_event: true, rationale: 'The lab’s own launch post.' },
      ],
      NOW,
    )
    const data = await queryTrackRecord(db, ctx())
    const row = data.rows.find((r) => r.alert_id === HASH(1))!
    expect(row.press.state).toBe('matched')
    expect(row.press.hit!.url).toBe(press[0]!.url)
    expect(row.press.lead_hours).toBe(leadHours(SAW, press[0]!.published_at))
    expect(row.press.lead_hours!).toBeGreaterThan(0)
    // The lab posted a minute before we fetched the page.
    expect(row.newsroom).toMatchObject({ state: 'matched', lead_hours: 0 })
    expect(data.press).toMatchObject({ matched: 1, led: 1, lagged: 0 })
    expect(data.newsroom).toMatchObject({ matched: 1, tied: 1 })

    // As of before the rating, the same row was unrated.
    const before = await queryTrackRecord(db, ctx('2026-11-04T11:00:00.000Z'))
    expect(before.rows.find((r) => r.alert_id === HASH(1))!.press.state).toBe('not-searched')
  })

  it('reads every side state from its searches, candidates and ratings', () => {
    const c = (id: number, at: string) =>
      ({
        id: HASH(id),
        published_at: at,
        title: 't',
        outlet: 'o',
        url: 'u',
        source_url: 's',
        fetched_at: at,
      }) as never
    const ok = [{ status: 'ok', detail: null }]
    const none = new Map()
    expect(sideOf(true, ok, [], none, SAW).state).toBe('window-open')
    expect(sideOf(false, [], [], none, SAW).state).toBe('not-searched')
    expect(sideOf(false, [{ status: 'failed', detail: 'HTTP 500' }], [], none, SAW)).toMatchObject({
      state: 'search-failed',
      detail: 'HTTP 500',
    })
    const busy = { status: 'failed', detail: 'HTTP 429' }
    expect(sideOf(false, [busy, busy], [], none, SAW)).toMatchObject({
      state: 'not-searched',
      detail: expect.stringContaining('retried'),
    })
    expect(
      sideOf(false, [busy, { status: 'failed', detail: 'HTTP 500' }], [], none, SAW).state,
    ).toBe('search-failed')
    expect(
      sideOf(false, [{ status: 'skipped', detail: 'no feed' }], [], none, SAW, 'no-feed').state,
    ).toBe('no-feed')
    expect(sideOf(false, ok, [], none, SAW).state).toBe('none-found')
    const two = [c(1, '2026-09-30T00:00:00Z'), c(2, '2026-09-29T00:00:00Z')]
    const lagged = new Map([[HASH(2), { same_event: true, rationale: 'r' }]])
    expect(sideOf(false, ok, two, lagged, SAW)).toMatchObject({ state: 'matched', lead_hours: -17 })
    const allNo = new Map([
      [HASH(1), { same_event: false, rationale: 'r' }],
      [HASH(2), { same_event: false, rationale: 'r' }],
    ])
    expect(sideOf(false, ok, two, allNo, SAW).state).toBe('no-match')
    expect(tally([sideOf(false, ok, two, lagged, SAW)])).toMatchObject({
      lagged: 1,
      median_lead_hours: -17,
    })
  })

  it('ids a candidate by alert, kind and URL', () => {
    expect(candidateId('a', 'press', 'u')).toBe(
      contentHash({ alert_id: 'a', kind: 'press', url: 'u' }),
    )
  })
})
