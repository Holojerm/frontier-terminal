import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import migration from '~~/server/db/migrations/0049_correct_google_flagship.sql?raw'
import { effectiveClassMap } from '../../server/pipeline/class-map'
import { cardDescriptions, cardOwners } from '../../server/pipeline/judge/page-cards'
import { basisOnPage, flattenMdLinks } from '../../server/pipeline/recommendations'
import { fixtureText } from './fixtures'

// Migration 0049 re-bases the google:flagship decision the judge wrote on
// 2026-11-10, which quoted Argon's card for Carbon. The page it now rests on is
// committed whole as fixtures/pricing/google-models.2026-11-11.md (fetched
// 2026-11-11T02:25:02Z from aistudio.google.com/docs/models.md), beside the
// seed's 2026-11-03 capture, so the corrected sentence is held to the gate's
// own page rules against the bytes it came from. It is not in
// fixtures/manifest.json: the poll suites serve one fixture per source URL, and
// the seed is transcribed from the older capture.

const db = drizzle(env.DB, { schema })

const PAGE = fixtureText('fixtures/pricing/google-models.2026-11-11.md')
const ARGON_CARD =
  'Our efficient Gemini 4 frontier reasoning model, delivering faster responses and lower token spend per turn compared to Gemini 4 Carbon across complex coding, agentic, math, and science tasks.'
const CARBON_CARD =
  'Our strongest reasoning model, built for complex software engineering, multimodal knowledge work, scientific reasoning, and cybersecurity defense.'
const JUDGED_AT = '2026-11-10T22:30:00.000Z'

const runMigration = () => env.DB.prepare(migration).run()

/** The judge's decision as production stores it (its id and exact time are not public). */
async function storeJudgeDecision() {
  await db.insert(schema.classMapDecisions).values({
    id: 'judge-decision',
    provider: 'google',
    class: 'flagship',
    model_slug: 'gemini-4-carbon',
    basis: ARGON_CARD,
    basis_source_id: 'google-models-md',
    decided_at: JUDGED_AT,
    decided_by: 'judge',
    source_url: 'https://aistudio.google.com/docs/models.md',
    fetched_at: '2026-11-10T22:00:58.000Z',
  })
}

const flagship = async (at: string | null = null) =>
  (await effectiveClassMap(db, at)).find((e) => e.provider === 'google' && e.class === 'flagship')

beforeEach(async () => {
  await db.delete(schema.classMapDecisions)
})

describe('migration 0049: the google:flagship decision', () => {
  it('quotes sentences from the captured page, each on the card the migration says', () => {
    expect(migration).toContain(CARBON_CARD)
    expect(migration).toContain(ARGON_CARD)
    const flat = flattenMdLinks(PAGE)
    expect(basisOnPage(flat, CARBON_CARD)).toBe(true)
    const cards = cardDescriptions('google-models-md', flat)
    expect(cardOwners(cards, CARBON_CARD)).toEqual(['gemini-4-carbon'])
    expect(cardOwners(cards, ARGON_CARD)).toEqual(['gemini-4-argon'])
  })

  it('puts Carbon’s own card in effect, and leaves the judge’s row as history', async () => {
    await storeJudgeDecision()
    await runMigration()

    expect(await flagship()).toMatchObject({
      model_slug: 'gemini-4-carbon',
      basis: CARBON_CARD,
      basis_source_id: 'google-models-md',
      verified_at: '2026-11-11T02:25:02.000Z',
    })
    // The matrix as it stood before the correction still reads as it did.
    expect((await flagship('2026-11-11T00:00:00.000Z'))?.basis).toBe(ARGON_CARD)

    const rows = await db.select().from(schema.classMapDecisions)
    expect(rows.map((r) => r.decided_by).sort()).toEqual(['judge', 'owner'])
  })

  it('touches a database without that decision not at all, and a second run adds nothing', async () => {
    await runMigration()
    expect(await db.select().from(schema.classMapDecisions)).toEqual([])

    await storeJudgeDecision()
    await runMigration()
    await runMigration()
    expect(await db.select().from(schema.classMapDecisions)).toHaveLength(2)
  })
})
