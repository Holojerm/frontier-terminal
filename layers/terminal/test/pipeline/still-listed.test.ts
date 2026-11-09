import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { ChangeRow, contentHash } from '../../server/pipeline/contracts'
import {
  falseDelisting,
  slugPattern,
  stillListedRemovals,
} from '../../server/pipeline/judge/still-listed'
import { submitJudgeRun } from '../../server/pipeline/judge/submit'
import { insertRows } from '../../server/pipeline/store'

// A model one page of a lab drops while another page still lists it is not
// delisted. The scenario is 2026-11-09: Anthropic's models overview dropped
// claude-fable-5-1 at the claude-fable-5-2 launch, the pricing page kept it,
// and the judge wrote "Anthropic delists claude-fable-5-1".

const db = drizzle(env.DB, { schema })
const AT = '2026-11-09T19:00:58.859Z'
const OVERVIEW = 'https://platform.claude.com/docs/en/models/overview.md'
const PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing.md'

const model = (model_slug: string, tier: string | null, input: number, output: number) => ({
  provider: 'anthropic',
  model_slug,
  tier,
  context_window: tier === null ? '1M tokens' : null,
  input_per_mtok: input,
  cached_input_per_mtok: null,
  output_per_mtok: output,
  currency: 'USD',
  effective_from: null,
  effective_until: null,
  notes: null,
})

const key = (slug: string, tier: string | null) =>
  `model:anthropic:${slug}${tier ? `:${tier}` : ''}`

function modelChange(
  change_type: 'added' | 'removed',
  row: ReturnType<typeof model>,
  source_url = OVERVIEW,
): ChangeRow {
  const json = JSON.stringify(row)
  const hash = contentHash(row)
  return ChangeRow.parse({
    id: contentHash({ change_type, source_url, row }),
    entity_key: key(row.model_slug, row.tier),
    entity_type: 'model',
    provider: 'anthropic',
    change_type,
    before_hash: change_type === 'removed' ? hash : null,
    after_hash: change_type === 'added' ? hash : null,
    before_json: change_type === 'removed' ? json : null,
    after_json: change_type === 'added' ? json : null,
    detected_at: AT,
    source_url,
    fetched_at: AT,
  })
}

/** The pricing page's current rows for a model, as the store holds them. */
const listedOnPricing = (row: ReturnType<typeof model>) => ({
  source_id: 'anthropic-pricing-md',
  entity_key: key(row.model_slug, row.tier),
  entity_type: 'model' as const,
  provider: 'anthropic' as const,
  snapshot_id: 'anthropic-pricing-md:1',
  content_hash: contentHash(row),
  payload: JSON.stringify(row),
  first_seen_at: '2026-09-01T00:00:00.000Z',
  source_url: PRICING,
  fetched_at: AT,
})

const removed51 = modelChange('removed', model('claude-fable-5-1', null, 10, 50))
const added52 = modelChange('added', model('claude-fable-5-2', null, 8, 40))

function submit(alerts: { severity: string; headline: string; explanation: string }[]) {
  const cited = [removed51, added52]
  return submitJudgeRun(
    db,
    JSON.stringify({
      alerts: alerts.map((a) => ({ ...a, change_ids: cited.map((c) => c.id) })),
      judged_through: AT,
      change_ids_seen: cited.map((c) => c.id),
    }),
    { clusters: [], now: new Date('2026-11-09T19:17:00Z') },
  )
}

// What the judge wrote that day, cut to the two changes above.
const WRONG = {
  severity: 'notable',
  headline: 'Anthropic delists claude-fable-5-1, launches claude-fable-5-2',
  explanation:
    "Anthropic's model catalog removed claude-fable-5-1, which priced input at 10 and output at 50 per MTok. It added claude-fable-5-2 (input 8, output 40 per MTok).",
}

const RIGHT = {
  severity: 'notable',
  headline: 'Anthropic launches claude-fable-5-2 at 8 in / 40 out per MTok',
  explanation:
    'The models overview now shows claude-fable-5-2 where claude-fable-5-1 was; it drops claude-fable-5-1 from that page, and the pricing page still lists it at input 10, output 50 per MTok.',
}

beforeEach(async () => {
  await db.delete(schema.alerts)
  await db.delete(schema.changes)
  await db.delete(schema.judgeRuns)
  await db.delete(schema.entities)
  await db.delete(schema.opsEvents)
  await insertRows(db, 'changes', [removed51, added52])
})

describe('stillListedRemovals', () => {
  it('names the pages that still list a removed model, with their tiers', async () => {
    await insertRows(db, 'entities', [
      listedOnPricing(model('claude-fable-5-1', null, 10, 50)),
      listedOnPricing(model('claude-fable-5-1', 'batch', 5, 25)),
    ])
    expect(await stillListedRemovals(db, [removed51, added52])).toEqual([
      {
        change_id: removed51.id,
        provider: 'anthropic',
        model_slug: 'claude-fable-5-1',
        removed_from: OVERVIEW,
        listed_on: [{ source_url: PRICING, tiers: ['batch', 'standard'] }],
      },
    ])
  })

  it('leaves out a removal no page lists any more: that one is a delisting', async () => {
    await insertRows(db, 'entities', [listedOnPricing(model('claude-fable-5-2', null, 8, 40))])
    expect(await stillListedRemovals(db, [removed51, added52])).toEqual([])
  })
})

describe('falseDelisting', () => {
  const slugs = ['claude-fable-5-1']

  it('catches the delisting words beside the model, however the model is spelled', () => {
    expect(falseDelisting(WRONG.headline, slugs, '')).toEqual({
      slug: 'claude-fable-5-1',
      word: 'delists',
    })
    expect(
      falseDelisting("Anthropic's model catalog removed claude-fable-5-1.", slugs, ''),
    ).toMatchObject({ word: 'catalog removed' })
    expect(falseDelisting('Claude Fable 5.1 is retired.', slugs, '')).toMatchObject({
      word: 'retired',
    })
    expect(falseDelisting('Fable 5.1 is no longer offered.', slugs, '')).toMatchObject({
      word: 'no longer offered',
    })
    expect(
      falseDelisting('Anthropic pulls claude-fable-5-1 from the API.', slugs, ''),
    ).not.toBeNull()
  })

  it('passes the accurate sentence, and delisting words about another model', () => {
    expect(falseDelisting(RIGHT.explanation, slugs, '')).toBeNull()
    expect(
      falseDelisting('Anthropic retires claude-opus-4-1. Fable 5.1 is cheaper.', slugs, ''),
    ).toBeNull()
    // A different model whose slug starts with this one's.
    expect(falseDelisting('claude-fable-5-1-mini is retired.', slugs, '')).toBeNull()
  })

  it('lets a word through when a cited record uses it', () => {
    const corpus = JSON.stringify({ notes: 'Deprecated; use claude-fable-5-2.' })
    expect(falseDelisting('claude-fable-5-1 is deprecated.', slugs, corpus)).toBeNull()
    expect(falseDelisting('claude-fable-5-1 is delisted.', slugs, corpus)).not.toBeNull()
  })

  it('spells a slug the ways a headline does', () => {
    const p = slugPattern('claude-fable-5-1')
    for (const text of ['claude-fable-5-1', 'claude fable 5.1', 'fable 5.1', 'fable-5.1,']) {
      expect(p.test(text)).toBe(true)
    }
    for (const text of ['claude-fable-5-10', 'fable 5.1-mini', 'fable 15.1']) {
      expect(p.test(text)).toBe(false)
    }
    // A two-part slug keeps its prefix.
    expect(slugPattern('gpt-5').test('the 5 tier')).toBe(false)
  })
})

describe('submitJudgeRun', () => {
  it('rejects the 2026-11-09 headline while the pricing page still lists the model', async () => {
    await insertRows(db, 'entities', [listedOnPricing(model('claude-fable-5-1', null, 10, 50))])
    const report = await submit([WRONG])
    expect(report).toMatchObject({ accepted: 0, inserted: 0, rejected: 1 })
    expect(report.rejections[0]).toMatchObject({ reason: 'still-listed' })
    expect(report.rejections[0]!.detail).toContain(PRICING)
    expect(await db.select().from(schema.alerts)).toEqual([])
    const kinds = (await db.select().from(schema.opsEvents)).map((e) => e.kind)
    expect(kinds).toEqual(['judge_rejected'])
  })

  it('keeps the accurate wording, at the severity the launch carries', async () => {
    await insertRows(db, 'entities', [listedOnPricing(model('claude-fable-5-1', null, 10, 50))])
    const report = await submit([RIGHT])
    expect(report).toMatchObject({ accepted: 1, inserted: 1, rejected: 0, clamped: [] })
    const [stored] = await db.select().from(schema.alerts)
    expect(stored?.severity).toBe('notable')
  })

  it('stores an alert citing only a still-listed removal as a ticker line', async () => {
    await insertRows(db, 'entities', [listedOnPricing(model('claude-fable-5-1', null, 10, 50))])
    const headline = 'Anthropic drops claude-fable-5-1 from its models overview'
    const report = await submitJudgeRun(
      db,
      JSON.stringify({
        alerts: [
          {
            severity: 'notable',
            headline,
            explanation: 'The pricing page still lists claude-fable-5-1.',
            change_ids: [removed51.id],
          },
        ],
        judged_through: AT,
        change_ids_seen: [removed51.id, added52.id],
      }),
      { clusters: [], now: new Date('2026-11-09T19:17:00Z') },
    )
    expect(report.clamped).toEqual([
      {
        headline,
        from: 'notable',
        to: 'info',
        detail: 'a model dropped from one page that another page of the lab still lists',
      },
    ])
    const [stored] = await db.select().from(schema.alerts)
    expect(stored?.severity).toBe('info')
  })

  it('lets a real delisting through: no page lists the model any more', async () => {
    const report = await submit([WRONG])
    expect(report).toMatchObject({ accepted: 1, inserted: 1, rejected: 0 })
  })
})
