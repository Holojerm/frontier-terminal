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
import { submitJudgeRun } from '../server/pipeline/judge/submit'
import { insertRows } from '../server/pipeline/store'
import {
  GKG_FROM,
  gkgSlots,
  gkgStamp,
  gkgUrl,
  parseGkgRow,
  stampIso,
  unzipOne,
} from '../server/pipeline/track-record/gkg'
import { acceptedMentions } from '../server/pipeline/track-record/mentions'
import {
  applyTrackRecordVerdicts,
  pendingCandidates,
  trackRecordReview,
} from '../server/pipeline/track-record/review'
import {
  PRESS_CANDIDATE_LIMIT,
  candidateId,
  gkgWork,
  recordGkgFile,
  runTrackRecordSearch,
  windowRead,
} from '../server/pipeline/track-record/search'
import {
  alertTerms,
  filerName,
  matchesArticle,
  matchesWhat,
  mentionVocabulary,
  modelFamily,
  termList,
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
    expect(termList(alertTerms([a, b])!)).toBe('gpt 6.1 | gpt 6')
    expect(alertTerms([b, a])!.what.sort()).toEqual(alertTerms([a, b])!.what.sort())
  })

  it('pairs a department with hiring words, and an incident with outage words', () => {
    const job = change({
      entity_type: 'job',
      entity_key: 'job:openai:x',
      after: { title: 'Head of Marketing Technology (MarTech)', department: 'Marketing' },
    })
    expect(termList(alertTerms([job])!)).toBe(
      'OpenAI + Marketing + hiring | jobs | job cuts | layoffs | roles',
    )
    const incident = change({
      entity_type: 'incident',
      provider: 'anthropic',
      entity_key: 'incident:anthropic:x',
      after: { title: 'Elevated errors for Claude Sonnet 5.5' },
    })
    expect(termList(alertTerms([incident])!)).toBe(
      'Anthropic | Claude + outage | outages | elevated errors | disruption',
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

  it('keeps a posted row with only the names the vocabulary holds', () => {
    const row = { record_id: 'r', outlet: 'x.com', url: 'https://x.com/a', title: 'T' }
    // A name the vocabulary lost (a delisted model) is dropped; a row left with none is not kept.
    expect(
      acceptedMentions(
        [
          { ...row, names: ['gpt', 'sora'] },
          { ...row, record_id: 's', names: ['sora'] },
          { ...row, record_id: 't', url: 'ftp://x.com/a', names: ['gpt'] },
        ],
        ['OpenAI', 'gpt'],
      ),
    ).toEqual([{ ...row, names: ['gpt'] }])
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
/** Alert 1's window, 7 days either side of SAW. */
const WINDOW = { start: '2026-09-22T17:01:00.000Z', end: '2026-10-06T17:01:00.000Z' }
/** When the job reads the fixture file, and when the cron finds alert 1's window closed. */
const READ = new Date('2026-09-29T19:01:00Z')
const CLOSE = new Date('2026-10-07T01:00:00Z')
/** What retentionVocabulary gives for the seeded model. */
const VOCAB = mentionVocabulary(['gpt-6.1-sol'])

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

async function seed() {
  await db.delete(schema.opsEvents)
  await db.delete(schema.gdeltFiles)
  await db.delete(schema.gkgMentions)
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
  // The model on record, so the vocabulary holds "gpt".
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
 * Marks every quarter hour from GKG_FROM up to (not including) `until` as
 * read, keeping no row but by `vocabulary` (null: read before rows were
 * kept), the way a caught-up job leaves gdelt_files. Generated in SQL: a
 * window needs thousands of rows. A file already recorded is left alone.
 */
async function markRead(until: string, vocabulary: readonly string[] | null = VOCAB) {
  await env.DB.prepare(
    `WITH RECURSIVE t(s) AS (
       SELECT unixepoch(?1) UNION ALL SELECT s + 900 FROM t WHERE s + 900 < unixepoch(?2)
     )
     INSERT OR IGNORE INTO gdelt_files
       (stamp, url, status, rows, matched, raw_key, fetched_at, recorded_at, mentions, vocabulary)
       SELECT strftime('%Y%m%d%H%M%S', s, 'unixepoch'), 'u', 'ok', 0, 0, NULL, ?3, ?3, ?4, ?5 FROM t`,
  )
    .bind(
      GKG_FROM,
      until,
      READ.toISOString(),
      vocabulary ? 0 : null,
      vocabulary ? JSON.stringify(vocabulary) : null,
    )
    .run()
}

/** The rows the job posts for a file: those carrying a word of `vocabulary`, compacted. */
const mentionsOf = (rows: readonly string[], vocabulary: readonly string[] = VOCAB) =>
  rows.flatMap((row) => {
    const a = parseGkgRow(row)
    const names = a ? vocabularyHits(a, vocabulary) : []
    return a && names.length
      ? [{ record_id: a.record_id, outlet: a.outlet, url: a.url, title: a.title, names }]
      : []
  })

const post = (stamp: string, rows: readonly string[], now: Date, status: 'ok' | 'missing' = 'ok') =>
  recordGkgFile(
    db,
    { stamp, fetched_at: now.toISOString(), status, rows: rows.length, mentions: mentionsOf(rows) },
    now,
  )

/** A caught-up job (the fixture file read at READ), then the cron once alert 1's window has closed. */
async function searchAll() {
  await markRead(stampIso(FIXTURE_STAMP))
  const outcome = await post(FIXTURE_STAMP, fixtureRows, READ)
  await markRead('2026-10-07T00:00:00Z')
  const report = await runTrackRecordSearch(db, { now: () => CLOSE })
  return { outcome, report }
}

const gdeltSearch = async (alertId = HASH(1)) =>
  (await db.select().from(schema.trackRecordSearches)).find(
    (r) => r.source === 'gdelt' && r.alert_id === alertId,
  )

describe('the search run', () => {
  beforeEach(seed)

  it('keeps the rows of a file that carry a vocabulary word, and matches nothing yet', async () => {
    await markRead(stampIso(FIXTURE_STAMP))
    const kept = mentionsOf(fixtureRows).length
    expect(kept).toBeGreaterThan(0)
    expect(await post(FIXTURE_STAMP, fixtureRows, READ)).toEqual({
      recorded: true,
      mentions: kept,
      rejected: 0,
      figures: 0,
    })
    expect(await db.select().from(schema.gkgMentions)).toHaveLength(kept)
    expect(await db.select().from(schema.trackRecordCandidates)).toEqual([])
    const [file] = await db
      .select()
      .from(schema.gdeltFiles)
      .where(eq(schema.gdeltFiles.stamp, FIXTURE_STAMP))
    expect(file).toMatchObject({ status: 'ok', rows: 4, matched: 0, raw_key: null, mentions: kept })
    expect(JSON.parse(file!.vocabulary!)).toEqual(VOCAB)
  })

  it('matches an alert against the rows kept for its window once the window has closed', async () => {
    const { report } = await searchAll()
    expect(report).toMatchObject({ newsroom: 1, gdelt: 1 })

    const candidates = await db.select().from(schema.trackRecordCandidates)
    expect(candidates.every((c) => c.alert_id === HASH(1))).toBe(true)
    // Of the fixture's rows, only cnet's headline carries "gpt 6.1".
    expect(candidates.filter((c) => c.kind === 'press')).toEqual([
      expect.objectContaining({
        outlet: 'cnet.com',
        published_at: '2026-09-29T18:30:00.000Z',
        search_id: `gkg:${FIXTURE_STAMP}`,
        source_url: gkgUrl(FIXTURE_STAMP),
        fetched_at: READ.toISOString(),
        found_at: CLOSE.toISOString(),
      }),
    ])
    expect(candidates.filter((c) => c.kind === 'newsroom')).toEqual([
      expect.objectContaining({ outlet: 'openai.com', published_at: '2026-09-29T17:00:00.000Z' }),
    ])
    // Every file in the window kept rows by a vocabulary holding "gpt": searched whole.
    expect(await gdeltSearch()).toMatchObject({
      status: 'ok',
      query: 'gpt 6.1',
      candidates: 1,
      window_start: WINDOW.start,
    })

    // A second run has nothing left to do.
    expect(await runTrackRecordSearch(db, { now: () => CLOSE })).toMatchObject({
      newsroom: 0,
      gdelt: 0,
      skipped: 0,
    })
  })

  it('keeps the earliest reports, one per headline, up to the limit', async () => {
    const at = (h: number) => new Date(Date.parse(WINDOW.start) + h * 3_600_000)
    const mention = (n: number, h: number, title: string) => ({
      record_id: `r${n}`,
      stamp: gkgStamp(at(h).getTime()),
      seen_at: stampIso(gkgStamp(at(h).getTime())),
      outlet: 'example.com',
      url: `https://example.com/${n}`,
      title,
      names: JSON.stringify(['gpt']),
      fetched_at: READ.toISOString(),
    })
    const rows = [
      // Before the window: never a candidate.
      mention(0, -2, 'GPT-6.1 rumors'),
      ...Array.from({ length: PRESS_CANDIDATE_LIMIT + 5 }, (_, i) =>
        mention(i + 1, i + 1, `GPT-6.1 take number ${i + 1}`),
      ),
      // The same headline syndicated an hour after its first copy.
      mention(100, 2.5, 'GPT-6.1 take number 1'),
      mention(101, 3.5, 'Weather tomorrow'),
    ]
    for (let i = 0; i < rows.length; i += 10) {
      await db.insert(schema.gkgMentions).values(rows.slice(i, i + 10))
    }
    await markRead('2026-10-07T00:00:00Z')
    await runTrackRecordSearch(db, { now: () => CLOSE })

    const press = (await db.select().from(schema.trackRecordCandidates))
      .filter((c) => c.kind === 'press')
      .sort((a, b) => a.published_at.localeCompare(b.published_at))
    expect(press.map((c) => c.url)).toEqual(
      Array.from({ length: PRESS_CANDIDATE_LIMIT }, (_, i) => `https://example.com/${i + 1}`),
    )
    expect((await gdeltSearch())!.candidates).toBe(PRESS_CANDIDATE_LIMIT)
  })

  it('reads a file only when it is the next one due, and a missing one advances the run', async () => {
    const at = new Date('2026-09-01T01:00:00Z')
    // Nothing read yet: only GKG_FROM's quarter hour is next.
    expect(await post(FIXTURE_STAMP, [], at)).toEqual({ recorded: false, reason: 'not-next' })
    expect(await post('20260901000000', [], new Date('2026-09-01T00:20:00Z'))).toEqual({
      recorded: false,
      reason: 'not-next',
    })
    expect(await post('20260901000000', [], at)).toMatchObject({ recorded: true })
    expect(await post('20260901000000', [], at)).toEqual({ recorded: false, reason: 'not-next' })
    // Skipping a quarter hour is refused; GDELT's 404 for it is recorded, and the run goes on.
    expect(await post('20260901003000', [], at)).toEqual({ recorded: false, reason: 'not-next' })
    expect(await post('20260901001500', [], at, 'missing')).toMatchObject({ recorded: true })
    expect(await post('20260901003000', [], at)).toMatchObject({ recorded: true })
    const [missing] = await db
      .select()
      .from(schema.gdeltFiles)
      .where(eq(schema.gdeltFiles.stamp, '20260901001500'))
    expect(missing).toMatchObject({ status: 'missing', rows: 0, vocabulary: null })
  })

  it('hands out the oldest unread files and the vocabulary to keep their rows by', async () => {
    const first = await gkgWork(db, NOW, 2)
    expect(first.files.map((f) => f.stamp)).toEqual(['20260901000000', '20260901001500'])
    expect(first.vocabulary).toEqual(VOCAB)

    await markRead('2026-09-29T00:00:00Z')
    expect((await gkgWork(db, NOW, 1)).files[0]!.stamp).toBe('20260929000000')
  })

  it('writes the GDELT side only once every file in the window is read', async () => {
    expect(await runTrackRecordSearch(db, { now: () => CLOSE })).toMatchObject({
      newsroom: 1,
      gdelt: 0,
    })
    // Everything read up to a day before the window ends: still not complete.
    await markRead('2026-10-05T17:01:00Z')
    expect((await runTrackRecordSearch(db, { now: () => CLOSE })).gdelt).toBe(0)
    await markRead('2026-10-07T00:00:00Z')
    expect((await runTrackRecordSearch(db, { now: () => CLOSE })).gdelt).toBe(1)
    expect(await gdeltSearch()).toMatchObject({ status: 'ok', candidates: 0 })
  })

  it('counts the search from after the last file read before rows were kept', async () => {
    await markRead('2026-09-25T00:00:00Z', null)
    await markRead('2026-10-07T00:00:00Z')
    await runTrackRecordSearch(db, { now: () => CLOSE })
    expect((await gdeltSearch())!.window_start).toBe('2026-09-25T00:00:00.000Z')

    const data = await queryTrackRecord(
      db,
      queryContext(sourcesYaml, null, () => NOW),
    )
    expect(data.rows.find((r) => r.alert_id === HASH(1))!.press).toMatchObject({
      state: 'none-found',
      searched_from: '2026-09-25T00:00:00.000Z',
    })
  })

  it('counts the search from when the model family’s word joined the vocabulary', async () => {
    // Before gpt-6.1-sol was on record, the vocabulary had no "gpt": those files
    // kept no row for alert 1, though they did for an alert naming OpenAI.
    const before = mentionVocabulary([])
    expect(termsInVocabulary({ who: ['OpenAI'], what: ['outage'], also: [] }, before)).toBe(true)
    await markRead('2026-09-29T17:00:00Z', before)
    await markRead('2026-10-07T00:00:00Z')
    await runTrackRecordSearch(db, { now: () => CLOSE })
    expect((await gdeltSearch())!.window_start).toBe('2026-09-29T17:00:00.000Z')
  })

  it('counts a window searched late only from the rows retention still holds', async () => {
    await markRead('2026-10-07T00:00:00Z')
    const late = new Date('2026-10-20T00:00:00Z')
    await runTrackRecordSearch(db, { now: () => late })
    // MENTION_RETAIN_DAYS (15) before the clock.
    expect((await gdeltSearch())!.window_start).toBe('2026-10-05T00:00:00.000Z')
  })

  it('drops kept rows past the retention days', async () => {
    await markRead(stampIso(FIXTURE_STAMP))
    await post(FIXTURE_STAMP, fixtureRows, READ)
    // Fifteen days on, a file's quarter hour is still held; a minute past it, not.
    await post('20260929184500', [], new Date('2026-10-14T18:30:00Z'))
    expect(await db.select().from(schema.gkgMentions)).not.toEqual([])
    await post('20260929190000', [], new Date('2026-10-14T18:31:00Z'))
    expect(await db.select().from(schema.gkgMentions)).toEqual([])
  })

  it('waits for the file holding the window’s last minute', () => {
    expect(windowRead(WINDOW, null)).toBe(false)
    expect(windowRead(WINDOW, '20261006164500')).toBe(false)
    expect(windowRead(WINDOW, '20261006170000')).toBe(true)
    // A window ending on a quarter hour needs that quarter hour's file too.
    const even = { ...WINDOW, end: '2026-10-06T17:00:00.000Z' }
    expect(windowRead(even, '20261006164500')).toBe(false)
    expect(windowRead(even, '20261006170000')).toBe(true)
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
    expect(before.rows.find((r) => r.alert_id === HASH(1))!.press.state).toBe('not-yet-rated')
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
    // A failure from GDELT's search API, before the GKG files, is no search at all.
    expect(sideOf(false, [{ status: 'failed', detail: 'HTTP 429' }], [], none, SAW).state).toBe(
      'not-searched',
    )
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
