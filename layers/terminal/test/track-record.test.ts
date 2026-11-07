import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import gkgFixture from '~~/fixtures/track-record/gkg-20260929183000.gkg.csv?raw'
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
  PRESS_CANDIDATE_LIMIT,
  candidateTitle,
  untokenizeTitle,
} from '../server/pipeline/track-record/gdelt'
import {
  GKG_FROM,
  gkgSlots,
  gkgStamp,
  gkgUrl,
  parseGkgRow,
  stampIso,
  unzipOne,
} from '../server/pipeline/track-record/gkg'
import {
  applyTrackRecordVerdicts,
  pendingCandidates,
  reviewCorpus,
  trackRecordReview,
} from '../server/pipeline/track-record/review'
import {
  candidateId,
  gkgWork,
  recordGkgFile,
  runTrackRecordSearch,
  windowRead,
} from '../server/pipeline/track-record/search'
import {
  alertTerms,
  filerName,
  gdeltQuery,
  matchesArticle,
  matchesWhat,
  mentionVocabulary,
  modelFamily,
  termsInVocabulary,
  vocabularyHits,
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
// the window around the saw-it time, the GDELT GKG and newsroom readers, the
// search run against a real D1, and the gate on the judge's same-event
// ratings. No network and no model: the GKG rows are a committed fixture (real
// rows from 2026-09-29), and the ratings are written here.

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

  it('keeps rows by lab, filer and model-family words, and knows which alerts that covers', () => {
    const vocabulary = mentionVocabulary(['gpt-6.1-sol', 'claude-opus-5-5', 'o3-pro'])
    // "claude" folds into the lab name "Claude"; "gpt" is new.
    expect(vocabulary).toEqual(expect.arrayContaining(['OpenAI', 'Microsoft', 'Claude', 'gpt']))
    expect(vocabulary).not.toContain('claude')
    expect(vocabulary).not.toContain('o3')
    const article = { title: 'GPT-6.1 Sol arrives', url: 'https://x.com/a', names: ['Sam Altman'] }
    expect(vocabularyHits(article, vocabulary)).toEqual(['gpt'])
    expect(vocabularyHits({ ...article, title: 'Weather' }, vocabulary)).toEqual([])
    // A model alert has no `who`: its family has to carry a vocabulary word.
    expect(termsInVocabulary({ who: [], what: ['gpt 6.1'], also: [] }, vocabulary)).toBe(true)
    expect(termsInVocabulary({ who: [], what: ['o3 pro'], also: [] }, vocabulary)).toBe(false)
    expect(termsInVocabulary({ who: ['Acme Robotics'], what: ['IPO'], also: [] }, vocabulary)).toBe(
      false,
    )
    expect(termsInVocabulary({ who: ['OpenAI'], what: ['outage'], also: [] }, vocabulary)).toBe(
      true,
    )
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

  it('spans 7 days either side, and closes for search at its end', () => {
    const w = trackWindow('2026-10-01T12:00:00.000Z')
    expect(w).toEqual({ start: '2026-09-24T12:00:00.000Z', end: '2026-10-08T12:00:00.000Z' })
    expect(searchState(w, new Date('2026-10-08T11:59:00Z'))).toBe('open')
    expect(searchState(w, new Date('2026-10-08T12:00:00Z'))).toBe('due')
    // GKG files go back years: an old window is searched like a new one.
    expect(searchState(w, new Date('2027-06-01T00:00:00Z'))).toBe('due')
  })

  it('signs a lead positive when we saw it first, and takes a median', () => {
    expect(leadHours('2026-09-29T17:01:00Z', '2026-09-29T18:30:00Z')).toBe(1.5)
    expect(leadHours('2026-09-29T17:01:00Z', '2026-09-29T15:01:00Z')).toBe(-2)
    expect(median([3, -1, 10])).toBe(3)
    expect(median([1, 2])).toBe(1.5)
    expect(median([])).toBeNull()
  })
})

const FIXTURE_STAMP = '20260929183000'
const fixtureRows = gkgFixture.split('\n').filter((l) => l.trim())
const cnetRow = fixtureRows.find((r) => r.includes('cnet.com/'))!

/** A one-entry zip of `text`, built the way GDELT's are: deflated, sizes in the central directory. */
async function zipOf(name: string, text: string): Promise<Uint8Array> {
  const body = new TextEncoder().encode(text)
  const stream = new Blob([body]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const data = new Uint8Array(await new Response(stream).arrayBuffer())
  const file = new TextEncoder().encode(name)
  const local = new DataView(new ArrayBuffer(30))
  local.setUint32(0, 0x04034b50, true)
  local.setUint16(6, 0x0008, true) // sizes follow in a data descriptor, so the local header has none
  local.setUint16(8, 8, true)
  local.setUint16(26, file.length, true)
  const central = new DataView(new ArrayBuffer(46))
  central.setUint32(0, 0x02014b50, true)
  central.setUint16(10, 8, true)
  central.setUint32(20, data.length, true)
  central.setUint32(24, body.length, true)
  central.setUint16(28, file.length, true)
  central.setUint32(42, 0, true)
  const centralAt = 30 + file.length + data.length
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, 1, true)
  eocd.setUint16(10, 1, true)
  eocd.setUint32(12, 46 + file.length, true)
  eocd.setUint32(16, centralAt, true)
  const parts = [new Uint8Array(local.buffer), file, data, new Uint8Array(central.buffer), file]
  const out = new Uint8Array(centralAt + 46 + file.length + 22)
  let at = 0
  for (const p of [...parts, new Uint8Array(eocd.buffer)]) {
    out.set(p, at)
    at += p.length
  }
  return out
}

describe('GDELT GKG files', () => {
  it('names a quarter hour the way GDELT does, and lists the due ones from GKG_FROM', () => {
    expect(gkgStamp(Date.parse('2026-09-29T18:30:00Z'))).toBe(FIXTURE_STAMP)
    expect(stampIso(FIXTURE_STAMP)).toBe('2026-09-29T18:30:00.000Z')
    expect(gkgUrl(FIXTURE_STAMP)).toBe(
      'http://data.gdeltproject.org/gdeltv2/20260929183000.gkg.csv.zip',
    )
    // GDELT publishes ~15 minutes behind; a file is asked for 30 minutes after its quarter hour.
    expect(gkgSlots(new Date('2026-09-01T00:44:00Z'))).toEqual(['20260901000000'])
    expect(gkgSlots(new Date('2026-09-01T00:45:00Z'))).toEqual(['20260901000000', '20260901001500'])
    expect(gkgSlots(new Date(GKG_FROM))).toEqual([])
  })

  it('reads a row’s quarter hour, outlet, URL, headline and names', () => {
    expect(fixtureRows).toHaveLength(4)
    expect(parseGkgRow(cnetRow)).toEqual({
      record_id: '20260929183000-364',
      seen_at: '2026-09-29T18:30:00.000Z',
      outlet: 'cnet.com',
      url: 'https://www.cnet.com/tech/services-and-software/everything-announced-at-openai-devday-subscription-changes-new-models-and-dots/',
      title: 'OpenAI DevDay: You Can Now Use GPT-6.1 Sol and Dots, Plus Big Subscription Changes',
      names: expect.arrayContaining(['Ziff Davis']),
    })
    for (const row of fixtureRows) expect(parseGkgRow(row)?.title).toBeTruthy()
    expect(parseGkgRow('not\ta\trow')).toBeNull()
  })

  it('unzips a file whose local header defers its sizes', async () => {
    const zip = await zipOf(`${FIXTURE_STAMP}.gkg.csv`, gkgFixture)
    expect(new TextDecoder().decode(await unzipOne(zip))).toBe(gkgFixture)
    await expect(unzipOne(new Uint8Array(64))).rejects.toThrow('not a zip')
  })

  it('matches the event in the headline or URL, and the company anywhere in the article', () => {
    const terms = { who: [], what: ['gpt 6.1'], also: [] }
    expect(matchesArticle(parseGkgRow(cnetRow)!, terms)).toBe(true)
    // The 9to5mac row names GPT-6.1 only in its text, not its headline or URL.
    const elsewhere = fixtureRows.find((r) => r.includes('9to5mac.com/'))!
    expect(matchesArticle(parseGkgRow(elsewhere)!, terms)).toBe(false)
    // A slug's "gpt-6-1" reads as "gpt 6.1"; "gpt-6-15" does not.
    const slug = (path: string, title = 'A headline') => ({
      title,
      url: `https://example.com/${path}`,
      names: [],
    })
    expect(matchesArticle(slug('2026/09/29/openai-scraps-gpt-6-1-astra/'), terms)).toBe(true)
    expect(matchesArticle(slug('gpt-6-15-ships'), terms)).toBe(false)
    const filing = { who: ['Microsoft'], what: ['earnings'], also: [] }
    expect(matchesArticle(slug('q3-earnings-beat'), filing)).toBe(false)
    expect(matchesArticle({ ...slug('q3-earnings-beat'), names: ['Microsoft'] }, filing)).toBe(true)
    const hiring = { who: ['OpenAI'], what: ['research'], also: ['hiring'] }
    expect(matchesArticle(slug('openai-research-hiring-spree'), hiring)).toBe(true)
    expect(matchesArticle(slug('openai-research-paper'), hiring)).toBe(false)
  })

  // Titles as production D1 held them on 2026-11-05, from GDELT's search API.
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
  recorded_at: c.fetched_at,
})

const memoryRaw = () => {
  const put: string[] = []
  return { put, store: { put: async (key: string) => void put.push(key) } }
}

async function seed() {
  await db.delete(schema.opsEvents)
  await db.delete(schema.gdeltFiles)
  await db.delete(schema.gkgMentions)
  await db.delete(schema.gkgBackfills)
  await db.delete(schema.entities)
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

/**
 * Marks every quarter hour from GKG_FROM up to `until` as read, but `except`,
 * the way a caught-up job leaves gdelt_files. Generated in SQL: a window needs
 * thousands of rows.
 */
async function markRead(
  until: string,
  except: string = FIXTURE_STAMP,
  mentions: number | null = null,
) {
  await env.DB.prepare(
    `WITH RECURSIVE t(s) AS (
       SELECT unixepoch(?1) UNION ALL SELECT s + 900 FROM t WHERE s + 900 < unixepoch(?2)
     )
     INSERT OR IGNORE INTO gdelt_files
       (stamp, url, status, rows, matched, raw_key, fetched_at, recorded_at, mentions)
       SELECT strftime('%Y%m%d%H%M%S', s, 'unixepoch'), 'u', 'ok', 0, 0, NULL, ?3, ?3, ?5 FROM t
       WHERE strftime('%Y%m%d%H%M%S', s, 'unixepoch') != ?4`,
  )
    .bind(GKG_FROM, until, NOW.toISOString(), except, mentions)
    .run()
}

/** What the job posts for the fixture file: every row, offered for `alertId`, matching or not. */
const fixtureFile = (alertId: string = HASH(1)) => ({
  stamp: FIXTURE_STAMP,
  fetched_at: NOW.toISOString(),
  status: 'ok' as const,
  rows: fixtureRows.length,
  matches: fixtureRows.map((row) => ({ alert_id: alertId, row })),
})

/** A caught-up job, then the cron: every file in alert 1's window read, the fixture's matches stored. */
async function searchAll(raw = memoryRaw()) {
  await markRead('2026-10-07T00:00:00Z')
  const outcome = await recordGkgFile(db, raw.store, fixtureFile(), NOW)
  const report = await runTrackRecordSearch(db, { now: () => NOW })
  return { outcome, report }
}

describe('the search run', () => {
  beforeEach(seed)

  it('keeps a posted row only when the Worker matches it to the alert itself', async () => {
    const raw = memoryRaw()
    const { outcome, report } = await searchAll(raw)
    // Of the four rows, only cnet's headline carries "gpt 6.1".
    expect(outcome).toEqual({ recorded: true, candidates: 1, duplicates: 0, rejected: 3 })
    expect(raw.put).toEqual([`track-record/gkg/${FIXTURE_STAMP}.tsv`])
    expect(report).toMatchObject({ newsroom: 1, gdelt: 1 })

    const candidates = await db.select().from(schema.trackRecordCandidates)
    expect(candidates.every((c) => c.alert_id === HASH(1))).toBe(true)
    const press = candidates.filter((c) => c.kind === 'press')
    expect(press).toEqual([
      expect.objectContaining({
        outlet: 'cnet.com',
        published_at: '2026-09-29T18:30:00.000Z',
        search_id: `gkg:${FIXTURE_STAMP}`,
        source_url: gkgUrl(FIXTURE_STAMP),
        fetched_at: NOW.toISOString(),
      }),
    ])
    expect(candidates.filter((c) => c.kind === 'newsroom')).toEqual([
      expect.objectContaining({ outlet: 'openai.com', published_at: '2026-09-29T17:00:00.000Z' }),
    ])
    const [file] = await db
      .select()
      .from(schema.gdeltFiles)
      .where(eq(schema.gdeltFiles.stamp, FIXTURE_STAMP))
    expect(file).toMatchObject({ status: 'ok', rows: 4, matched: 1 })

    // A second run has nothing left to do.
    expect(await runTrackRecordSearch(db, { now: () => NOW })).toMatchObject({
      newsroom: 0,
      gdelt: 0,
      skipped: 0,
    })
  })

  it('reads a file once, and only once it is due', async () => {
    const post = (stamp: string) =>
      recordGkgFile(db, memoryRaw().store, { ...fixtureFile(), stamp }, NOW)
    expect(await post(FIXTURE_STAMP)).toMatchObject({ recorded: true })
    expect(await post(FIXTURE_STAMP)).toEqual({ recorded: false, reason: 'not-due' })
    // Not yet published, and not a quarter hour.
    expect(await post('20261104120000')).toEqual({ recorded: false, reason: 'not-due' })
    expect(await post('20260929183100')).toEqual({ recorded: false, reason: 'not-due' })
  })

  it('refuses matches for an alert whose window does not cover the file', async () => {
    // Alert 2's window opens on 2026-10-25; alert 3 is not material.
    for (const id of [HASH(2), HASH(3)]) {
      await seed()
      expect(await recordGkgFile(db, memoryRaw().store, fixtureFile(id), NOW)).toMatchObject({
        candidates: 0,
        rejected: 4,
      })
    }
    expect(await db.select().from(schema.trackRecordCandidates)).toHaveLength(0)
  })

  it('keeps one candidate per headline, and records a quarter hour GDELT never published', async () => {
    const twice = {
      ...fixtureFile(),
      matches: [cnetRow, cnetRow].map((row) => ({ alert_id: HASH(1), row })),
    }
    expect(await recordGkgFile(db, memoryRaw().store, twice, NOW)).toMatchObject({
      candidates: 1,
      duplicates: 1,
    })
    const missing = { ...fixtureFile(), stamp: '20260929184500', status: 'missing' as const }
    expect(await recordGkgFile(db, memoryRaw().store, missing, NOW)).toMatchObject({
      recorded: true,
      candidates: 0,
    })
    const [file] = await db
      .select()
      .from(schema.gdeltFiles)
      .where(eq(schema.gdeltFiles.stamp, '20260929184500'))
    expect(file).toMatchObject({ status: 'missing', rows: 0, raw_key: null })
  })

  it('hands out the oldest unread files, with the alerts whose windows overlap them', async () => {
    const first = await gkgWork(db, NOW, 2)
    expect(first.files.map((f) => f.stamp)).toEqual(['20260901000000', '20260901001500'])
    // No material alert's window reaches back to 2026-09-01.
    expect(first.alerts).toEqual([])

    await markRead('2026-09-29T00:00:00Z')
    const later = await gkgWork(db, NOW, 1)
    expect(later.files[0]!.stamp).toBe('20260929000000')
    expect(later.alerts).toEqual([
      expect.objectContaining({
        alert_id: HASH(1),
        terms: { who: [], what: ['gpt 6.1'], also: [] },
      }),
    ])
  })

  it('writes the GDELT side only once every file in the window is read', async () => {
    expect(await runTrackRecordSearch(db, { now: () => NOW })).toMatchObject({
      newsroom: 1,
      gdelt: 0,
    })
    // Everything read up to a day before the window ends: still not complete.
    await markRead('2026-10-05T17:01:00Z', '')
    expect((await runTrackRecordSearch(db, { now: () => NOW })).gdelt).toBe(0)
    await markRead('2026-10-07T00:00:00Z', '')
    expect((await runTrackRecordSearch(db, { now: () => NOW })).gdelt).toBe(1)
    const [row] = await db
      .select()
      .from(schema.trackRecordSearches)
      .where(eq(schema.trackRecordSearches.source, 'gdelt'))
    expect(row).toMatchObject({
      status: 'ok',
      query: '"gpt 6.1" sourcelang:english',
      candidates: 0,
    })
  })

  it('records where the press search began when the window’s first files were read before the alert existed', async () => {
    await markRead('2026-10-07T00:00:00Z', '')
    // Files up to 18:45 were read before the alert was written at 18:40 (and
    // the 18:45 one within the job's batch lag after it): never matched to it.
    await env.DB.prepare(
      `UPDATE gdelt_files SET recorded_at = '2026-09-29T18:50:00.000Z' WHERE stamp < '20260929190000'`,
    ).run()
    await db
      .update(schema.alerts)
      .set({ recorded_at: '2026-09-29T18:40:00.000Z' })
      .where(eq(schema.alerts.id, HASH(1)))
    expect((await runTrackRecordSearch(db, { now: () => NOW })).gdelt).toBe(1)
    const rows = await db.select().from(schema.trackRecordSearches)
    const gdelt = rows.find((r) => r.source === 'gdelt' && r.alert_id === HASH(1))!
    expect(gdelt.window_start).toBe('2026-09-29T19:00:00.000Z')
    expect(rows.find((r) => r.source === 'newsroom')!.window_start).toBe('2026-09-22T17:01:00.000Z')

    const data = await queryTrackRecord(
      db,
      queryContext(sourcesYaml, null, () => NOW),
    )
    expect(data.rows.find((r) => r.alert_id === HASH(1))!.press).toMatchObject({
      state: 'none-found',
      searched_from: '2026-09-29T19:00:00.000Z',
    })
  })

  describe('mentions kept for alerts written later', () => {
    // The fixture file is read at 19:01, before alert 1 is written at 19:02,
    // so the job matches nothing to it; a file read at 19:40 backfills it.
    const READ = new Date('2026-09-29T19:01:00Z')
    const LATER = new Date('2026-09-29T19:40:00Z')
    const vocabulary = mentionVocabulary(['gpt-6.1-sol'])
    const mentionsOf = (rows: readonly string[]) =>
      rows.flatMap((row) => {
        const a = parseGkgRow(row)
        const names = a ? vocabularyHits(a, vocabulary) : []
        return a && names.length
          ? [{ record_id: a.record_id, outlet: a.outlet, url: a.url, title: a.title, names }]
          : []
      })

    beforeEach(async () => {
      await db.insert(schema.entities).values({
        source_id: 'openai-models-md',
        entity_key: 'model:openai:gpt-6.1-sol:standard',
        entity_type: 'model',
        provider: 'openai',
        content_hash: HASH(7),
        payload: JSON.stringify({ model_slug: 'gpt-6.1-sol' }),
        snapshot_id: 's',
        first_seen_at: SAW,
        source_url: 'https://developers.openai.com/api/docs/models.md',
        fetched_at: SAW,
      })
      await db
        .update(schema.alerts)
        .set({ recorded_at: '2026-09-29T19:02:00.000Z' })
        .where(eq(schema.alerts.id, HASH(1)))
    })

    const post = (stamp: string, rows: readonly string[], now: Date) =>
      recordGkgFile(
        db,
        memoryRaw().store,
        {
          stamp,
          fetched_at: now.toISOString(),
          status: 'ok',
          rows: rows.length,
          matches: [],
          mentions: mentionsOf(rows),
        },
        now,
      )

    it('keeps the rows that name a tracked lab or model, and matches a later alert against them', async () => {
      expect(await post(FIXTURE_STAMP, fixtureRows, READ)).toMatchObject({ candidates: 0 })
      const kept = await db.select().from(schema.gkgMentions)
      expect(kept.length).toBeGreaterThan(0)
      expect(kept.every((m) => (JSON.parse(m.names) as string[]).length > 0)).toBe(true)

      // The next file: alert 1 is 38 minutes old, so it is backfilled.
      expect(await post('20260929190000', [], LATER)).toMatchObject({ candidates: 1 })
      const press = await db.select().from(schema.trackRecordCandidates)
      expect(press).toEqual([
        expect.objectContaining({
          alert_id: HASH(1),
          outlet: 'cnet.com',
          published_at: '2026-09-29T18:30:00.000Z',
          search_id: `gkg:backfill:${FIXTURE_STAMP}`,
          source_url: gkgUrl(FIXTURE_STAMP),
        }),
      ])
      const [back] = await db
        .select()
        .from(schema.gkgBackfills)
        .where(eq(schema.gkgBackfills.alert_id, HASH(1)))
      expect(back).toMatchObject({ through_stamp: '20260929190000', covered: 1, candidates: 1 })
      // Once only.
      expect(await post('20260929191500', [], new Date('2026-09-29T19:50:00Z'))).toMatchObject({
        candidates: 0,
      })
    })

    /**
     * Every file in alert 1's window read with mentions kept, those before
     * 19:00 read before the alert was written (so going forward the search
     * would begin at 19:00), then the cron's search row.
     */
    async function searchedFrom(keptFrom: string | null = null): Promise<string> {
      await markRead('2026-10-07T00:00:00Z', '', 0)
      await env.DB.prepare(
        `UPDATE gdelt_files SET recorded_at = '2026-09-29T18:50:00.000Z' WHERE stamp < '20260929190000'`,
      ).run()
      if (keptFrom) {
        await env.DB.prepare(`UPDATE gdelt_files SET mentions = NULL WHERE stamp < ?1`)
          .bind(gkgStamp(Date.parse(keptFrom)))
          .run()
      }
      for (const stamp of [FIXTURE_STAMP, '20260929190000']) {
        await db.delete(schema.gdeltFiles).where(eq(schema.gdeltFiles.stamp, stamp))
      }
      await post(FIXTURE_STAMP, fixtureRows, READ)
      await post('20260929190000', [], LATER)
      expect((await runTrackRecordSearch(db, { now: () => NOW })).gdelt).toBe(1)
      const rows = await db.select().from(schema.trackRecordSearches)
      return rows.find((r) => r.source === 'gdelt' && r.alert_id === HASH(1))!.window_start
    }

    it('counts a backfilled window as searched from its start once every file in it was kept', async () => {
      expect(await searchedFrom()).toBe('2026-09-22T17:01:00.000Z')
    })

    it('still counts from the first kept file when earlier ones were read before mentions were kept', async () => {
      expect(await searchedFrom('2026-09-25T00:00:00.000Z')).toBe('2026-09-25T00:00:00.000Z')
    })

    it('counts from the forward match when the alert was never backfilled', async () => {
      await markRead('2026-10-07T00:00:00Z', '', 0)
      await env.DB.prepare(
        `UPDATE gdelt_files SET recorded_at = '2026-09-29T18:50:00.000Z' WHERE stamp < '20260929190000'`,
      ).run()
      await runTrackRecordSearch(db, { now: () => NOW })
      const rows = await db.select().from(schema.trackRecordSearches)
      expect(rows.find((r) => r.source === 'gdelt' && r.alert_id === HASH(1))!.window_start).toBe(
        '2026-09-29T19:00:00.000Z',
      )
    })

    it('drops kept rows past the retention days', async () => {
      await post(FIXTURE_STAMP, fixtureRows, READ)
      const later = new Date('2026-10-08T19:01:00Z')
      await post('20261008183000', [], later)
      expect(await db.select().from(schema.gkgMentions)).toEqual([])
    })
  })

  it('waits for the last files of a window that has only just closed', () => {
    const window = { start: '2026-09-22T17:01:00.000Z', end: '2026-10-06T17:01:00.000Z' }
    // The file for 17:00 holds the window's last minute; it is due at 17:30.
    expect(windowRead(window, '20261006164500', null)).toBe(false)
    expect(windowRead(window, '20261006170000', null)).toBe(true)
    expect(windowRead(window, '20261006170000', '20261006170000')).toBe(false)
    expect(windowRead(window, '20261007000000', '20261006171500')).toBe(true)
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

  it('reads a press side with only search-API failures as not searched yet', async () => {
    await seed()
    await db.insert(schema.trackRecordSearches).values({
      id: 'busy',
      alert_id: HASH(1),
      source: 'gdelt',
      query: '"gpt 6.1" sourcelang:english',
      window_start: '2026-09-22T17:01:00.000Z',
      window_end: '2026-10-06T17:01:00.000Z',
      status: 'failed',
      detail: 'HTTP 429',
      candidates: 0,
      searched_at: '2026-11-04T00:00:00.000Z',
      raw_key: null,
      source_url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=x',
    })
    const data = await queryTrackRecord(db, ctx())
    expect(data.rows.find((r) => r.alert_id === HASH(1))!.press.state).toBe('not-searched')
  })

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
      searched_in_part: 0,
    })
    // A side searched only part way through its window is shown, never tallied.
    const part = { ...sideOf(false, ok, two, lagged, SAW), searched_from: '2026-09-29T19:00:00Z' }
    expect(tally([part])).toMatchObject({
      matched: 0,
      lagged: 0,
      median_lead_hours: null,
      searched_in_part: 1,
    })
  })

  it('ids a candidate by alert, kind and URL', () => {
    expect(candidateId('a', 'press', 'u')).toBe(
      contentHash({ alert_id: 'a', kind: 'press', url: 'u' }),
    )
  })
})
