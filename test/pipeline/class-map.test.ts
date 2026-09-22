import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../../server/db/schema'
import { effectiveClassMap, overlayClassMap } from '../../server/pipeline/class-map'
import type { SourceFetcher } from '../../server/pipeline/fetch'
import {
  basisNamesModel,
  classMapReview,
  modelNamedBy,
  REVIEW_WINDOW_MS,
  type RawReader,
} from '../../server/pipeline/judge/class-map'
import { submitJudgeRun } from '../../server/pipeline/judge/submit'
import { recommendationRows } from '../../server/pipeline/recommendations'
import { runRefresh, type RawStore } from '../../server/pipeline/refresh'
import { terminalStamp } from '../../server/utils/terminal-cache'
import { CLASS_MAP_SOURCES, MODEL_CLASS_MAP } from '../../server/utils/terminal-classes'
import { queryContext, queryPrices } from '../../server/utils/terminal-db'
import { fixtureText } from './fixtures'

// The judge re-mapping a price-matrix cell. Pure halves first, then the whole
// path against the workerd D1 and R2: a real poll of the committed Anthropic
// models page, a second poll of the same page rewritten the way a launch
// rewrites it, the review the judge is handed, and the gate on what it sends
// back. No model is invoked; the proposals are written here.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const PAGE_URL = 'https://platform.claude.com/docs/en/models/overview.md'

const OLD_FLAGSHIP =
  "If you're unsure which model to use, start with Claude Opus 5 for most workloads."
const NEW_FLAGSHIP =
  "If you're unsure which model to use, start with Claude Opus 5.5 for most workloads."
const OLD_BALANCED = 'The best combination of speed and intelligence'
const NEW_BALANCED = 'Our best balance of speed and intelligence'

const OLD_LINE =
  'start with [Claude Opus 5](https://platform.claude.com/docs/en/models/opus-5/overview) for most'
const NEW_LINE =
  'start with [Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview) for most'

const FIXTURE = fixtureText('fixtures/pricing/anthropic-models-overview.md')

/** The committed page as a launch rewrites it: Opus 5 becomes Opus 5.5, Sonnet's line changes. */
function launched(page: string): string {
  let text = page.replace(OLD_LINE, NEW_LINE)
  text = text.replaceAll('`claude-opus-5`', '`claude-opus-5-5`')
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
  model_slug: 'claude-opus-5-5',
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

async function opsKinds(): Promise<string[]> {
  const rows = await db.select().from(schema.opsEvents)
  return rows.map((row) => row.kind)
}

beforeEach(async () => {
  for (const table of [
    schema.sourceRuns,
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
    expect(basisNamesModel(NEW_FLAGSHIP, 'claude-opus-5-5')).toBe(true)
    expect(basisNamesModel(NEW_FLAGSHIP, 'claude-opus-5')).toBe(false)
    expect(basisNamesModel(OLD_FLAGSHIP, 'claude-opus-5')).toBe(true)
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

describe('overlayClassMap', () => {
  const decision = (over: Record<string, string>) => ({
    provider: 'anthropic',
    class: 'flagship',
    model_slug: 'claude-opus-5-5',
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
      decision({ model_slug: 'claude-opus-5-1', decided_at: '2026-09-22T04:30:00.000Z' }),
      decision({}),
      decision({ provider: 'xai', class: 'economy', model_slug: 'grok-4.3', basis: 'x' }),
    ])
    expect(map).toHaveLength(MODEL_CLASS_MAP.length + 1)
    const flagship = map.find((e) => e.provider === 'anthropic' && e.class === 'flagship')
    expect(flagship).toEqual({
      provider: 'anthropic',
      class: 'flagship',
      model_slug: 'claude-opus-5-5',
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
    const cells = review.cells.map((c) => `${c.provider}:${c.class}:${c.current.model_slug}`)
    expect(cells).toEqual([
      'anthropic:balanced:claude-sonnet-5',
      'anthropic:flagship:claude-opus-5',
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
    const balanced = { class: 'balanced', model_slug: 'claude-sonnet-5', basis: NEW_BALANCED }
    const report = await submit([proposal(), proposal(balanced)])
    expect(report.gate_rejection).toBeNull()
    expect(report.class_map).toEqual({ accepted: 2, rejected: [] })

    const [decision] = await db
      .select()
      .from(schema.classMapDecisions)
      .where(eq(schema.classMapDecisions.class, 'flagship'))
    expect(decision).toMatchObject({
      provider: 'anthropic',
      model_slug: 'claude-opus-5-5',
      basis: NEW_FLAGSHIP,
      decided_by: 'judge',
      decided_at: NOW.toISOString(),
      source_url: PAGE_URL,
    })
    expect(await opsKinds()).toContain('class_map_changed')

    // The map in effect, the review, and the matrix all move with it.
    const map = await effectiveClassMap(db)
    const flagship = map.find((e) => e.provider === 'anthropic' && e.class === 'flagship')
    expect(flagship?.model_slug).toBe('claude-opus-5-5')
    expect((await classMapReview(db, readRaw, NOW)).cells).toEqual([])

    const ctx = queryContext(sourcesYaml, await terminalStamp(db), () => NOW)
    const { matrix } = await queryPrices(db, ctx)
    const cell = matrix.cells.find((c) => c.provider === 'anthropic' && c.class === 'flagship')
    expect(cell?.row?.model_slug).toBe('claude-opus-5-5')
    expect(cell?.basis).toBe(NEW_FLAGSHIP)
    expect(cell?.basis_current).toBe(true)
    expect(cell?.basis_note).toBeNull()

    // The next poll's drift check runs against the new mapping.
    const prov = { source_url: PAGE_URL, fetched_at: NOW.toISOString() }
    const rows = recommendationRows('anthropic-models-md', LAUNCHED, prov, map)
    const check = rows.find((r) => r.class === 'flagship')
    expect(check).toMatchObject({ model_slug: 'claude-opus-5-5', present: true })
  })

  it('rejects, for its typed reason, everything that is not the vendor’s own sentence', async () => {
    const report = await submit([
      proposal({ provider: 'xai', model_slug: 'grok-4.7', basis_source_id: 'xai-models-md' }),
      proposal({ basis_source_id: 'anthropic-pricing-md' }),
      proposal({ basis: 'Start with Claude Opus 5.5 for most workloads.' }),
      proposal({ model_slug: 'claude-opus-9' }),
      proposal({ model_slug: 'claude-sonnet-5' }),
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
    // claude-opus-5 left the table with the rewrite, so it is not a listed model.
    const report = await submit([proposal({ model_slug: 'claude-opus-5' })])
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
