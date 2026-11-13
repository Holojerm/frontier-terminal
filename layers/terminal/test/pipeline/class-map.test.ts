import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { effectiveClassMap, overlayClassMap } from '../../server/pipeline/class-map'
import type { SourceFetcher } from '../../server/pipeline/fetch'
import {
  basisNamesModel,
  classMapReview,
  modelNamedBy,
  REVIEW_WINDOW_MS,
  type RawReader,
} from '../../server/pipeline/judge/class-map'
import { cardDescriptions } from '../../server/pipeline/judge/page-cards'
import { submitJudgeRun } from '../../server/pipeline/judge/submit'
import { recommendationRows } from '../../server/pipeline/recommendations'
import { runRefresh, type RawStore } from '../../server/pipeline/refresh'
import { terminalStamps } from '../../server/utils/terminal-cache'
import { MODEL_FLOOR_RULE } from '../../server/pipeline/model-floor'
import { CLASS_GAPS, CLASS_MAP_SOURCES, MODEL_CLASS_MAP } from '../../server/utils/terminal-classes'
import { queryContext } from '../../server/utils/terminal-db'
import { queryPrices } from '../../server/utils/terminal-prices'
import { fixtureText, manifest } from './fixtures'

// The judge re-mapping a price-matrix cell. Pure halves first, then the whole
// path against the workerd D1 and R2: a real poll of the committed Anthropic
// models page, a second poll of the same page rewritten the way a launch
// rewrites it, the review the judge is handed, and the gate on what it sends
// back. No model is invoked; the proposals are written here.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const PAGE_URL = 'https://platform.claude.com/docs/en/models/overview.md'

// The committed page is the Opus 5.5 generation; the launch rewritten onto it
// is a hypothetical Opus 6.
const OLD_FLAGSHIP =
  'If you’re unsure which model to use, start with Claude Opus 5.5 for most workloads.'
const NEW_FLAGSHIP =
  'If you’re unsure which model to use, start with Claude Opus 6 for most workloads.'
const OLD_BALANCED = 'The best combination of speed and intelligence'
const NEW_BALANCED = 'Our best balance of speed and intelligence'

const OLD_LINE =
  'start with [Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview) for most'
const NEW_LINE =
  'start with [Claude Opus 6](https://platform.claude.com/docs/en/models/opus-6/overview) for most'

const FIXTURE = fixtureText('fixtures/pricing/anthropic-models-overview.md')

/** The committed page as a launch rewrites it: Opus 5.5 becomes Opus 6, Sonnet's line changes. */
function launched(page: string): string {
  let text = page.replace(OLD_LINE, NEW_LINE)
  text = text.replaceAll('`claude-opus-5-5`', '`claude-opus-6`')
  return text.replace(OLD_BALANCED, NEW_BALANCED)
}
const LAUNCHED = launched(FIXTURE)

const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}
const readRaw: RawReader = async (key) => {
  const object = await env.BLOB.get(key)
  return object ? object.text() : null
}
const noPages: RawReader = async () => null

let tick = Date.parse('2026-09-22T04:00:00Z')
const clock = () => new Date((tick += 1000))
const NOW = new Date('2026-09-22T05:00:00Z')
const IDS = ['anthropic-models-md']

function poll(text: string) {
  const fetcher: SourceFetcher = async () => ({
    ok: true,
    status: 200,
    text,
    bytes: text.length,
  })
  return runRefresh({ db, raw, fetcher, sourcesYaml, now: clock }, 'survey', IDS)
}

const proposal = (over: Record<string, unknown> = {}) => ({
  provider: 'anthropic',
  class: 'flagship',
  model_slug: 'claude-opus-6',
  basis: NEW_FLAGSHIP,
  basis_source_id: 'anthropic-models-md',
  ...over,
})

function submit(class_map: unknown[], pages: RawReader = readRaw) {
  const body = {
    alerts: [],
    class_map,
    judged_through: '2026-09-22T04:00:00Z',
    change_ids_seen: [],
  }
  return submitJudgeRun(db, JSON.stringify(body), { now: NOW, readRaw: pages })
}

/** The decisions the judge wrote, leaving out any a test seeded as the map's history. */
const judged = () =>
  db.select().from(schema.classMapDecisions).where(eq(schema.classMapDecisions.decided_by, 'judge'))

async function opsKinds(): Promise<string[]> {
  const rows = await db.select().from(schema.opsEvents)
  return rows.map((row) => row.kind)
}

beforeEach(async () => {
  for (const table of [
    schema.sourceRuns,
    schema.sourceStats,
    schema.snapshots,
    schema.entities,
    schema.changes,
    schema.alerts,
    schema.opsEvents,
    schema.judgeRuns,
    schema.classMapDecisions,
  ]) {
    await db.delete(table)
  }
  tick = Date.parse('2026-09-22T04:00:00Z')
})

describe('naming', () => {
  it('a sentence names a slug only when no version number continues it', () => {
    const terra = 'Choose GPT-5.6 Terra to balance intelligence and cost'
    expect(basisNamesModel(OLD_FLAGSHIP, 'claude-opus-5-5')).toBe(true)
    expect(basisNamesModel(OLD_FLAGSHIP, 'claude-opus-5')).toBe(false)
    expect(basisNamesModel(NEW_FLAGSHIP, 'claude-opus-6')).toBe(true)
    expect(basisNamesModel(terra, 'gpt-5.6-terra')).toBe(true)
    expect(basisNamesModel('For everything else, use Grok 4.7.', 'grok-4')).toBe(false)
  })

  it('of the listed models a sentence names, the outermost one is the one it names', () => {
    const astra = "If you're not sure where to start, use GPT-6 Astra, our flagship model."
    const both = 'Use GPT-5.6 Terra or GPT-5.6 Luna.'
    expect(modelNamedBy(astra, ['gpt-6', 'gpt-6-astra', 'gpt-5.6-luna'])).toBe('gpt-6-astra')
    expect(modelNamedBy(astra, ['gpt-5.6-luna'])).toBe(null)
    expect(modelNamedBy(both, ['gpt-5.6-terra', 'gpt-5.6-luna'])).toBe(null)
  })
})

describe('quote typography', () => {
  const prov = { source_url: PAGE_URL, fetched_at: NOW.toISOString() }
  const flagship = (page: string) =>
    recommendationRows('anthropic-models-md', page, prov).find((r) => r.class === 'flagship')

  // The page printed a straight apostrophe until 2026-11-11 and a curly one since.
  it('either apostrophe on the page keeps the recommendation present (issue #83)', () => {
    const straight = FIXTURE.replace('If you’re unsure', "If you're unsure")
    expect(straight).not.toBe(FIXTURE)
    expect(flagship(FIXTURE)?.present).toBe(true)
    expect(flagship(straight)?.present).toBe(true)
  })

  it('a reworded recommendation still reads as gone', () => {
    expect(flagship(LAUNCHED)?.present).toBe(false)
  })
})

describe('overlayClassMap', () => {
  const decision = (over: Record<string, string>) => ({
    provider: 'anthropic',
    class: 'flagship',
    model_slug: 'claude-opus-6',
    basis: NEW_FLAGSHIP,
    basis_source_id: 'anthropic-models-md',
    decided_at: '2026-09-22T05:00:00.000Z',
    fetched_at: '2026-09-22T04:00:02.000Z',
    ...over,
  })

  it('is the seed when nothing was decided', () => {
    expect(overlayClassMap(MODEL_CLASS_MAP, [])).toEqual(MODEL_CLASS_MAP)
  })

  it('puts the newest decision per cell in the seed entry’s place and fills a gap', () => {
    const map = overlayClassMap(MODEL_CLASS_MAP, [
      decision({ model_slug: 'claude-opus-5-5', decided_at: '2026-09-22T04:30:00.000Z' }),
      decision({}),
      decision({ provider: 'xai', class: 'economy', model_slug: 'grok-4.3', basis: 'x' }),
    ])
    expect(map).toHaveLength(MODEL_CLASS_MAP.length + 1)
    const flagship = map.find((e) => e.provider === 'anthropic' && e.class === 'flagship')
    expect(flagship).toEqual({
      provider: 'anthropic',
      class: 'flagship',
      model_slug: 'claude-opus-6',
      basis: NEW_FLAGSHIP,
      basis_source_id: 'anthropic-models-md',
      verified_at: '2026-09-22T04:00:02.000Z',
    })
    const economy = map.find((e) => e.provider === 'xai' && e.class === 'economy')
    expect(economy?.model_slug).toBe('grok-4.3')
  })

  it('every provider the seed maps has its class-map page, and the seed cites only those', () => {
    for (const entry of MODEL_CLASS_MAP) {
      expect(CLASS_MAP_SOURCES[entry.provider]).toBe(entry.basis_source_id)
    }
  })
})

describe('the review the judge is handed', () => {
  it('is empty while every sentence is still on the page', async () => {
    await poll(FIXTURE)
    await poll(FIXTURE)
    expect(await classMapReview(db, readRaw, NOW)).toEqual({ cells: [], pages: [] })
  })

  it('lists the cells whose sentence left the page, with the page as last fetched', async () => {
    await poll(FIXTURE)
    await poll(LAUNCHED)
    const review = await classMapReview(db, readRaw, NOW)
    const cells = review.cells.map((c) => `${c.provider}:${c.class}:${c.current?.model_slug}`)
    expect(cells).toEqual([
      'anthropic:balanced:claude-sonnet-5-5',
      'anthropic:flagship:claude-opus-5-5',
    ])
    expect(review.pages.map((p) => p.source_id)).toEqual(['anthropic-models-md'])
    // Links flattened, so the judge copies what the Worker will match against.
    expect(review.pages[0]!.text).toContain(NEW_FLAGSHIP)
  })

  it('stops offering a cell once the window has passed', async () => {
    await poll(FIXTURE)
    await poll(LAUNCHED)
    const later = new Date(NOW.getTime() + REVIEW_WINDOW_MS + 60 * 60 * 1000)
    expect((await classMapReview(db, readRaw, later)).cells).toEqual([])
  })
})

describe('a judge re-mapping', () => {
  beforeEach(async () => {
    await poll(FIXTURE)
    await poll(LAUNCHED)
  })

  it('is accepted when the sentence is on the page and names the model, and the matrix follows', async () => {
    const balanced = { class: 'balanced', model_slug: 'claude-sonnet-5-5', basis: NEW_BALANCED }
    const report = await submit([proposal(), proposal(balanced)])
    expect(report.gate_rejection).toBeNull()
    expect(report.class_map).toEqual({ accepted: 2, rejected: [] })

    const [decision] = await db
      .select()
      .from(schema.classMapDecisions)
      .where(eq(schema.classMapDecisions.class, 'flagship'))
    expect(decision).toMatchObject({
      provider: 'anthropic',
      model_slug: 'claude-opus-6',
      basis: NEW_FLAGSHIP,
      decided_by: 'judge',
      decided_at: NOW.toISOString(),
      source_url: PAGE_URL,
    })
    expect(await opsKinds()).toContain('class_map_changed')

    // The map in effect, the review, and the matrix all move with it.
    const map = await effectiveClassMap(db)
    const flagship = map.find((e) => e.provider === 'anthropic' && e.class === 'flagship')
    expect(flagship?.model_slug).toBe('claude-opus-6')
    expect((await classMapReview(db, readRaw, NOW)).cells).toEqual([])

    const ctx = queryContext(sourcesYaml, (await terminalStamps(db)).poll, () => NOW)
    const { matrix } = await queryPrices(db, ctx)
    const cell = matrix.cells.find((c) => c.provider === 'anthropic' && c.class === 'flagship')
    expect(cell?.row?.model_slug).toBe('claude-opus-6')
    expect(cell?.basis).toBe(NEW_FLAGSHIP)
    expect(cell?.basis_current).toBe(true)
    expect(cell?.basis_note).toBeNull()

    // The next poll's drift check runs against the new mapping.
    const prov = { source_url: PAGE_URL, fetched_at: NOW.toISOString() }
    const rows = recommendationRows('anthropic-models-md', LAUNCHED, prov, map)
    const check = rows.find((r) => r.class === 'flagship')
    expect(check).toMatchObject({ model_slug: 'claude-opus-6', present: true })
  })

  it('accepts a model’s own description when its row also carries a "From" price note', async () => {
    // 2026-10-09: Haiku 5.5 replaced Haiku 4.5 with a "From" price, the parser
    // appended a note to the row's description, and every re-mapping onto the
    // description was rejected as not the model's own. Replayed here as a
    // hypothetical Haiku 6 that keeps the "From" price.
    const HAIKU_5_5 =
      'For high-volume, latency-sensitive tasks such as classification, extraction, and routing'
    const HAIKU_6 = 'For high-volume, latency-sensitive tasks at the lowest cost per token'
    const page = LAUNCHED.replace(HAIKU_5_5, HAIKU_6).replaceAll(
      '`claude-haiku-5-5`',
      '`claude-haiku-6`',
    )
    await poll(page)
    const [row] = await db
      .select({ payload: schema.entities.payload })
      .from(schema.entities)
      .where(eq(schema.entities.entity_key, 'model:anthropic:claude-haiku-6'))
    expect(JSON.parse(row!.payload).notes).toContain('"From" price')

    const report = await submit([
      proposal({ class: 'economy', model_slug: 'claude-haiku-6', basis: HAIKU_6 }),
    ])
    expect(report.class_map).toEqual({ accepted: 1, rejected: [] })
  })

  it('accepts the sentence with its apostrophe curled where the page has it straight', async () => {
    const report = await submit([proposal({ basis: NEW_FLAGSHIP.replace("'", '’') })])
    expect(report.class_map).toEqual({ accepted: 1, rejected: [] })
  })

  it('rejects, for its typed reason, everything that is not the vendor’s own sentence', async () => {
    const report = await submit([
      proposal({ provider: 'xai', model_slug: 'grok-4.7', basis_source_id: 'xai-models-md' }),
      proposal({ basis_source_id: 'anthropic-pricing-md' }),
      proposal({ basis: 'Start with Claude Opus 6 for most workloads.' }),
      proposal({ model_slug: 'claude-opus-9' }),
      proposal({ model_slug: 'claude-sonnet-5-5' }),
    ])
    expect(report.class_map.accepted).toBe(0)
    expect(report.class_map.rejected.map((r) => r.reason)).toEqual([
      'not-under-review',
      'wrong-source',
      'basis-not-on-page',
      'unknown-model',
      'basis-does-not-name-model',
    ])
    expect(await db.select().from(schema.classMapDecisions)).toEqual([])
    expect(await opsKinds()).toContain('judge_rejected')
  })

  it('an old slug is never re-attached to the new sentence', async () => {
    // claude-opus-5-5 left the table with the rewrite, so it is not a listed model.
    const report = await submit([proposal({ model_slug: 'claude-opus-5-5' })])
    expect(report.class_map.rejected.map((r) => r.reason)).toEqual(['unknown-model'])
  })

  it('without a stored page nothing can be verified, so nothing is written', async () => {
    const report = await submit([proposal()], noPages)
    expect(report.class_map.rejected.map((r) => r.reason)).toEqual(['no-page'])
    expect(await db.select().from(schema.classMapDecisions)).toEqual([])
  })

  it('one cell is decided once per run', async () => {
    const report = await submit([proposal(), proposal()])
    expect(report.class_map.accepted).toBe(1)
    expect(report.class_map.rejected.map((r) => r.reason)).toEqual(['not-under-review'])
  })

  it('a body without class_map is exactly what the judge always sent', async () => {
    const body = { alerts: [], judged_through: '2026-09-22T04:00:00Z', change_ids_seen: [] }
    const report = await submitJudgeRun(db, JSON.stringify(body), { now: NOW, readRaw })
    expect(report.gate_rejection).toBeNull()
    expect(report.class_map).toEqual({ accepted: 0, rejected: [] })
  })
})

describe('the cards on a page that does not name its models', () => {
  const GOOGLE = fixtureText('fixtures/pricing/google-models.md')
  const ALIBABA = fixtureText('fixtures/pricing/alibaba-models.html')

  it('reads each card’s description under the model the card itself names', () => {
    const google = cardDescriptions('google-models-md', GOOGLE)
    // A block card, named by its Model code line.
    expect([...google.get('gemini-4-argon')!]).toEqual([
      'Our efficient Gemini 4 frontier reasoning model, delivering faster responses and lower token spend per turn compared to Gemini 4 Carbon across complex coding, agentic, math, and science tasks.',
    ])
    expect(google.get('gemini-4-hydrogen')).toContain(
      'Brings cutting-edge intelligence to everyone, with speed and efficiency for everyday coding and agentic workflows, featuring a shared 1M context window and long decodes up to 1M tokens.',
    )
    // A self-closing card, named by its href.
    expect(google.get('gemini-3.5-flash-lite')).toContain(
      'Our fastest, most cost-effective 3.5 model for high-throughput execution.',
    )
    const alibaba = cardDescriptions('alibaba-models-html', ALIBABA)
    expect(alibaba.get('qwen3.8-max')).toContain('Complex reasoning and coding')
    expect(cardDescriptions('anthropic-models-md', FIXTURE).size).toBe(0)
  })

  it('holds every seed sentence for those pages under the seed’s own model', () => {
    const pages: Record<string, string> = {
      'google-models-md': GOOGLE,
      'alibaba-models-html': ALIBABA,
    }
    const seeded = MODEL_CLASS_MAP.filter((e) => e.basis_source_id in pages)
    expect(seeded.length).toBeGreaterThan(0)
    for (const entry of seeded) {
      const cards = cardDescriptions(entry.basis_source_id, pages[entry.basis_source_id]!)
      expect(cards.get(entry.model_slug), `${entry.provider}:${entry.class}`).toContain(entry.basis)
    }
  })
})

describe('a judge re-mapping onto a Google card (issue #360)', () => {
  // Replayed on the page as it was before the rewrite, with the map as it was:
  // Argon the flagship. The seed has moved on to Carbon since.
  const GOOGLE = fixtureText('fixtures/pricing/google-models.2026-11-03.md')
  const ARGON_OLD =
    'Our flagship reasoning model with a shared 1M context window and long decodes up to 1M tokens.'
  // Argon's card as served on 2026-11-11: it names Carbon, to compare itself.
  const ARGON_NEW =
    'Our efficient Gemini 4 frontier reasoning model, delivering faster responses and lower token spend per turn compared to Gemini 4 Carbon across complex coding, agentic, math, and science tasks.'
  const CARBON =
    'Our strongest reasoning model, built for complex software engineering, multimodal knowledge work, scientific reasoning, and cybersecurity defense.'
  const CARBON_CARD = `  {% card description="${CARBON}" title="Gemini 4 Carbon" variant="model-card" %}
  {% section class="model-specs" %}
  *   *Model code* **gemini-4-carbon**
  *   *Context* **1M tokens**

  {% /section %}

  {% /card %}

`
  // The 2026-11-10 rewrite as the judge reported it: a Carbon card ahead of
  // Argon's, and Argon re-described as the cheaper option.
  const REWRITTEN = GOOGLE.replace(ARGON_OLD, ARGON_NEW).replace(
    '{% card-grid columns="2" %}\n',
    `{% card-grid columns="2" %}\n${CARBON_CARD}`,
  )

  function pollGoogle(text: string) {
    const fetcher: SourceFetcher = async () => ({ ok: true, status: 200, text, bytes: text.length })
    return runRefresh({ db, raw, fetcher, sourcesYaml, now: clock }, 'survey', ['google-models-md'])
  }

  /** Catalog rows as the pricing page leaves them: tier notes, no description. */
  async function listGoogleModels(slugs: string[]) {
    for (const slug of slugs) {
      await db.insert(schema.entities).values({
        source_id: 'google-pricing-html',
        entity_key: `model:google:${slug}`,
        entity_type: 'model',
        provider: 'google',
        content_hash: slug,
        payload: JSON.stringify({ model_slug: slug, notes: 'Standard tier' }),
        snapshot_id: 'pricing',
        first_seen_at: NOW.toISOString(),
        source_url: 'https://aistudio.google.com/docs/pricing.md',
        fetched_at: NOW.toISOString(),
      })
    }
  }

  const google = (over: Record<string, unknown> = {}) =>
    proposal({
      provider: 'google',
      model_slug: 'gemini-4-carbon',
      basis: CARBON,
      basis_source_id: 'google-models-md',
      ...over,
    })

  beforeEach(async () => {
    expect(REWRITTEN).toContain(CARBON_CARD)
    await db.insert(schema.classMapDecisions).values({
      id: 'argon-as-it-was',
      provider: 'google',
      class: 'flagship',
      model_slug: 'gemini-4-argon',
      basis: ARGON_OLD,
      basis_source_id: 'google-models-md',
      decided_at: '2026-09-22T03:00:00.000Z',
      decided_by: 'owner',
      source_url: 'https://aistudio.google.com/docs/models.md',
      fetched_at: '2026-09-22T03:00:00.000Z',
    })
    await listGoogleModels(['gemini-4-argon', 'gemini-4-carbon'])
    await pollGoogle(GOOGLE)
    await pollGoogle(REWRITTEN)
  })

  it('accepts the description on the proposed model’s own card', async () => {
    const cells = (await classMapReview(db, readRaw, NOW)).cells.map(
      (c) => `${c.provider}:${c.class}`,
    )
    // Balanced too: the seed quotes Hydrogen's card, which no page this old has.
    expect(cells).toEqual(['google:balanced', 'google:flagship'])

    const report = await submit([google()])
    expect(report.class_map).toEqual({ accepted: 1, rejected: [] })
    const map = await effectiveClassMap(db)
    const flagship = map.find((e) => e.provider === 'google' && e.class === 'flagship')
    expect(flagship).toMatchObject({ model_slug: 'gemini-4-carbon', basis: CARBON })
  })

  it('rejects one model’s card sentence proposed for another', async () => {
    const report = await submit([google({ model_slug: 'gemini-4-argon' })])
    expect(report.class_map.rejected.map((r) => r.reason)).toEqual(['basis-is-another-models-card'])
    expect(await judged()).toEqual([])
  })

  it('rejects a card that mentions the model only to compare itself to it', async () => {
    // 2026-11-10: this sentence names Gemini 4 Carbon and no other model, so
    // the naming rule passed it, and the matrix showed Carbon as Google's
    // flagship on the strength of Argon's description.
    const report = await submit([google({ basis: ARGON_NEW })])
    expect(report.class_map.rejected).toEqual([
      expect.objectContaining({
        reason: 'basis-is-another-models-card',
        detail: "the sentence is the description on gemini-4-argon's card, not gemini-4-carbon's",
      }),
    ])
    expect(await judged()).toEqual([])
  })
})

describe('a launch re-opens its lab’s empty cells (Gemini 4 Hydrogen, 2026-11-12)', () => {
  // Google listed Hydrogen with a card that answers its balanced column, and
  // nothing offered that cell to anyone: only a mapped cell has a sentence to
  // lose. Replayed as a hypothetical Meta launch, since Meta's balanced column
  // is still a stated gap.
  const META = fixtureText('fixtures/pricing/meta-models.md')
  const BLOOM = "Muse Bloom is Meta's best balance of intelligence and cost for everyday work."
  const ANCHOR = "Pick one by what you're building"
  const LAUNCHED_META = META.replace(ANCHOR, `${BLOOM} ${ANCHOR}`)
  const LISTED_AT = '2026-09-22T04:30:00.000Z'
  const META_GAP = CLASS_GAPS.find((g) => g.provider === 'meta' && g.class === 'balanced')!

  /** The models page as given; its per-line side pages from their committed fixtures. */
  function pollMeta(text: string) {
    const fetcher: SourceFetcher = async (source) => {
      const side = manifest.fixtures.find((f) => f.source_url === source.url)
      const body = source.source_id === 'meta-models-md' || !side ? text : fixtureText(side.path)
      return { ok: true, status: 200, text: body, bytes: body.length }
    }
    return runRefresh({ db, raw, fetcher, sourcesYaml, now: clock }, 'survey', ['meta-models-md'])
  }

  /** What the model-floor rule leaves for a launch: the added row, its change, its alert. */
  async function launch(provider: string, slug: string, at = LISTED_AT) {
    const url = 'https://example.com/catalog'
    await db.insert(schema.entities).values({
      source_id: `${provider}-catalog`,
      entity_key: `model:${provider}:${slug}`,
      entity_type: 'model',
      provider,
      content_hash: slug,
      payload: JSON.stringify({ model_slug: slug, notes: 'Standard tier' }),
      snapshot_id: 'catalog',
      first_seen_at: at,
      source_url: url,
      fetched_at: at,
    })
    const changeId = `added-${provider}-${slug}`
    await db.insert(schema.changes).values({
      id: changeId,
      entity_key: `model:${provider}:${slug}`,
      entity_type: 'model',
      provider,
      change_type: 'added',
      after_json: JSON.stringify({ provider, model_slug: slug }),
      detected_at: at,
      source_url: url,
      fetched_at: at,
    })
    await db.insert(schema.alerts).values({
      id: `floor-${provider}-${slug}`,
      severity: 'notable',
      headline: `lists a new model, ${slug}`,
      explanation: 'x',
      change_ids: JSON.stringify([changeId]),
      rule: MODEL_FLOOR_RULE,
      created_at: at,
      source_url: url,
      fetched_at: at,
    })
  }

  const bloom = (over: Record<string, unknown> = {}) =>
    proposal({
      provider: 'meta',
      class: 'balanced',
      model_slug: 'muse-bloom',
      basis: BLOOM,
      basis_source_id: 'meta-models-md',
      ...over,
    })

  beforeEach(async () => {
    expect(LAUNCHED_META).toContain(BLOOM)
    await pollMeta(META)
    await pollMeta(LAUNCHED_META)
  })

  it('offers the launching lab’s empty cells, with the launched slugs, and nothing else', async () => {
    await launch('meta', 'muse-bloom')
    // Anthropic has no empty cell; DeepSeek has no class-map page to quote.
    await launch('anthropic', 'claude-opus-6')
    await launch('deepseek', 'deepseek-v5')
    const review = await classMapReview(db, readRaw, NOW)
    expect(review.cells).toEqual([
      {
        provider: 'meta',
        class: 'balanced',
        reason: 'launch-into-gap',
        current: null,
        gap: META_GAP.reason,
        launched: ['muse-bloom'],
        since: LISTED_AT,
      },
    ])
    expect(review.pages.map((p) => p.source_id)).toEqual(['meta-models-md'])
    expect(review.pages[0]!.text).toContain(BLOOM)
  })

  it('offers nothing without a launch, or once the window has passed', async () => {
    expect((await classMapReview(db, readRaw, NOW)).cells).toEqual([])
    await launch('meta', 'muse-bloom')
    const later = new Date(Date.parse(LISTED_AT) + REVIEW_WINDOW_MS + 60 * 60 * 1000)
    expect((await classMapReview(db, readRaw, later)).cells).toEqual([])
  })

  it('fills the gap with the launched model’s own sentence, and the cell leaves review', async () => {
    await launch('meta', 'muse-bloom')
    const report = await submit([bloom()])
    expect(report.class_map).toEqual({ accepted: 1, rejected: [] })

    const map = await effectiveClassMap(db)
    const balanced = map.find((e) => e.provider === 'meta' && e.class === 'balanced')
    expect(balanced).toMatchObject({ model_slug: 'muse-bloom', basis: BLOOM })
    expect((await classMapReview(db, readRaw, NOW)).cells).toEqual([])
    const [changed] = await db
      .select()
      .from(schema.opsEvents)
      .where(eq(schema.opsEvents.kind, 'class_map_changed'))
    expect(changed!.detail).toContain('meta:balanced: (gap) -> muse-bloom')

    // The next poll's drift check holds the filled cell to its sentence.
    const prov = { source_url: 'https://dev.meta.ai/docs/models.md', fetched_at: NOW.toISOString() }
    const check = recommendationRows('meta-models-md', LAUNCHED_META, prov, map).find(
      (r) => r.class === 'balanced',
    )
    expect(check).toMatchObject({ model_slug: 'muse-bloom', present: true })
  })

  it('takes no model the launch did not list, and no sentence the page does not print', async () => {
    await launch('meta', 'muse-bloom')
    const SPARK =
      "Muse Spark is Meta's model for agentic and coding work at scale, such as multi-step tool loops, software engineering assistants, and long-context reasoning."
    const report = await submit([
      bloom({ model_slug: 'muse-spark-1.3', basis: SPARK }),
      bloom({ basis: 'Muse Bloom balances intelligence and cost.' }),
    ])
    expect(report.class_map.rejected.map((r) => r.reason)).toEqual([
      'not-a-launched-model',
      'basis-not-on-page',
    ])
    expect(await db.select().from(schema.classMapDecisions)).toEqual([])
  })
})
