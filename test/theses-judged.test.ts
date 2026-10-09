import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, describe, expect, it } from 'vitest'

import type { ClaimDef, JudgedSpec, ThesisDef } from '#shared/utils/thesis-types'

import * as schema from '../server/db/schema'
import { contentHash, type ChangeRow } from '../server/pipeline/contracts'
import { submitJudgeRun } from '../server/pipeline/judge/submit'
import { ANTHROPIC_THESIS } from '../server/theses/anthropic'
import { claimCandidates } from '../server/theses/candidates'
import { evaluateJudgedClaim, type StoredVerdict } from '../server/theses/judged-status'
import { claimReview } from '../server/theses/verdicts'
import { queryContext } from '../server/utils/terminal-db'
import { queryTheses } from '../server/utils/terminal-theses'
import { fixtureText } from './pipeline/fixtures'

// Judged claims end to end: which changes the Worker offers, the status rules
// over stored verdicts, and the judge's verdicts gated through the real
// submit path — a verdict on a change the Worker would not offer, with a
// verdict the claim does not allow, or with an ungrounded rationale is dropped.

const db = drizzle(env.DB, { schema })
const sourcesYaml = fixtureText('sources.yaml')
const claim = (id: string) => ANTHROPIC_THESIS.claims.find((c) => c.id === id)!
const PRICE_WAR = claim('anthropic-rival-price-war')
const SAFETY = claim('anthropic-safety-asset')
const FLAGSHIPS = new Map([
  ['openai', 'gpt-6-astra'],
  ['anthropic', 'claude-opus-5'],
])

function change(
  partial: Partial<ChangeRow> & Pick<ChangeRow, 'entity_key' | 'entity_type' | 'provider'>,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): ChangeRow {
  const before_json = before && JSON.stringify(before)
  const after_json = after && JSON.stringify(after)
  return {
    id: contentHash({ k: partial.entity_key, before_json, after_json }),
    change_type: before ? (after ? 'modified' : 'removed') : 'added',
    before_hash: before_json && contentHash(before_json),
    after_hash: after_json && contentHash(after_json),
    before_json,
    after_json,
    detected_at: '2026-10-10T06:00:00Z',
    source_url: 'https://developers.openai.com/api/docs/pricing.md',
    fetched_at: '2026-10-10T06:00:00Z',
    ...partial,
  }
}

const price = (model_slug: string, input: number, output: number) => ({
  model_slug,
  tier: 'standard',
  input_per_mtok: input,
  output_per_mtok: output,
})

const OPENAI_CUT = change(
  { entity_key: 'model:openai:gpt-6-astra', entity_type: 'model', provider: 'openai' },
  price('gpt-6-astra', 10, 50),
  price('gpt-6-astra', 6, 30),
)
const NON_FLAGSHIP_CUT = change(
  { entity_key: 'model:openai:gpt-6-luna', entity_type: 'model', provider: 'openai' },
  price('gpt-6-luna', 0.2, 1),
  price('gpt-6-luna', 0.1, 0.5),
)
const LONG_OUTAGE = change(
  {
    entity_key: 'incident:anthropic:abc',
    entity_type: 'incident',
    provider: 'anthropic',
    source_url: 'https://status.claude.com/api/v2/incidents.json',
  },
  null,
  {
    title: 'Elevated errors on Claude API',
    impact: 'major',
    started_at: '2026-10-10T01:00:00Z',
    resolved_at: '2026-10-10T04:30:00Z',
  },
)
const SHORT_OUTAGE = change(
  { entity_key: 'incident:anthropic:def', entity_type: 'incident', provider: 'anthropic' },
  null,
  {
    title: 'Brief errors',
    impact: 'critical',
    started_at: '2026-10-10T01:00:00Z',
    resolved_at: '2026-10-10T01:30:00Z',
  },
)

describe('claim candidates', () => {
  it('offers only flagship cuts, with the Worker computing the size', () => {
    const got = claimCandidates(
      ANTHROPIC_THESIS,
      PRICE_WAR,
      [OPENAI_CUT, NON_FLAGSHIP_CUT],
      FLAGSHIPS,
    )
    expect(got.map((c) => c.change.id)).toEqual([OPENAI_CUT.id])
    expect(got[0]!.facts.cut_pct).toBe(40)
    expect(got[0]!.subject).toBe(OPENAI_CUT.id)
  })

  it('offers only incidents at the impact bar lasting two hours, keyed by incident', () => {
    const got = claimCandidates(ANTHROPIC_THESIS, SAFETY, [LONG_OUTAGE, SHORT_OUTAGE], FLAGSHIPS)
    expect(got.map((c) => c.subject)).toEqual(['incident:anthropic:abc'])
    expect(got[0]!.facts.hours).toBe(3.5)
  })

  it('offers nothing detected before the claim was first judged', () => {
    const early = { ...OPENAI_CUT, detected_at: '2026-10-01T00:00:00Z' }
    expect(claimCandidates(ANTHROPIC_THESIS, PRICE_WAR, [early], FLAGSHIPS)).toEqual([])
  })
})

describe('judged status rules', () => {
  const NOW = '2026-10-12T00:00:00Z'
  const v = (
    provider: StoredVerdict['provider'],
    verdict: string,
    extra: Partial<StoredVerdict> = {},
  ): StoredVerdict => ({
    subject: `${provider}-${verdict}-${extra.detected_at ?? ''}`,
    provider,
    verdict,
    facts: { model_slug: 'm', cut_pct: 40, title: 'Outage' },
    detected_at: '2026-10-10T00:00:00Z',
    ...extra,
  })

  it('is unresolved until a judge run covers judged_from', () => {
    expect(
      evaluateJudgedClaim(PRICE_WAR, 'anthropic', [], '2026-10-08T00:00:00Z', NOW).status,
    ).toBe('unresolved')
    expect(
      evaluateJudgedClaim(PRICE_WAR, 'anthropic', [], '2026-10-11T00:00:00Z', NOW).status,
    ).toBe('holding')
  })

  it('weakens at one competitive rival cut, breaks at two plus an Anthropic match', () => {
    const through = '2026-10-11T00:00:00Z'
    const one = [v('openai', 'competitive')]
    expect(evaluateJudgedClaim(PRICE_WAR, 'anthropic', one, through, NOW).status).toBe('weakening')
    const two = [...one, v('google', 'competitive', { detected_at: '2026-10-10T01:00:00Z' })]
    expect(evaluateJudgedClaim(PRICE_WAR, 'anthropic', two, through, NOW).status).toBe('weakening')
    const matched = [...two, v('anthropic', 'competitive', { detected_at: '2026-10-11T00:00:00Z' })]
    expect(evaluateJudgedClaim(PRICE_WAR, 'anthropic', matched, through, NOW).status).toBe('broken')
  })

  it('ignores small cuts, generational cuts, and cuts older than the window', () => {
    const through = '2026-10-11T00:00:00Z'
    const verdicts = [
      v('openai', 'competitive', { facts: { model_slug: 'm', cut_pct: 10 } }),
      v('openai', 'generational'),
      v('openai', 'competitive', { detected_at: '2026-06-01T00:00:00Z' }),
    ]
    expect(evaluateJudgedClaim(PRICE_WAR, 'anthropic', verdicts, through, NOW).status).toBe(
      'holding',
    )
  })

  it('weakens on an unconfirmed material event and breaks once confirmed', () => {
    const through = '2026-10-11T00:00:00Z'
    const material = [v('anthropic', 'material', { subject: 'incident:anthropic:abc' })]
    const waiting = evaluateJudgedClaim(SAFETY, 'anthropic', material, through, NOW)
    expect(waiting.status).toBe('weakening')
    expect(waiting.reason).toContain('awaiting confirmation')
    const confirmed: ClaimDef = {
      ...SAFETY,
      spec: {
        ...(SAFETY.spec as Extract<JudgedSpec, { review: 'incidents-and-disclosures' }>),
        confirmations: [
          { subject: 'incident:anthropic:abc', decision: 'confirmed', on: '2026-10-12', note: '' },
        ],
      },
    }
    expect(evaluateJudgedClaim(confirmed, 'anthropic', material, through, NOW).status).toBe(
      'broken',
    )
    const rival = [v('openai', 'material')]
    expect(evaluateJudgedClaim(SAFETY, 'anthropic', rival, through, NOW).status).toBe('holding')
  })
})

describe('verdicts through the judge submit path', () => {
  beforeAll(async () => {
    for (const c of [OPENAI_CUT, NON_FLAGSHIP_CUT, LONG_OUTAGE])
      await db.insert(schema.changes).values(c)
  })

  it('lists the candidates in the CLAIM REVIEW block', () => {
    const review = claimReview([OPENAI_CUT, NON_FLAGSHIP_CUT, LONG_OUTAGE], FLAGSHIPS)
    expect(review.map((r) => [r.claim_id, r.candidates.length])).toEqual([
      ['anthropic-rival-price-war', 1],
      ['anthropic-safety-asset', 1],
    ])
    expect(review[0]!.verdicts).toEqual(['competitive', 'generational'])
  })

  it('stores gated verdicts, rejects the rest, and moves the claim status', async () => {
    const body = {
      alerts: [],
      judged_through: '2026-10-10T06:00:00Z',
      change_ids_seen: [OPENAI_CUT.id, NON_FLAGSHIP_CUT.id, LONG_OUTAGE.id],
      claims: [
        {
          claim_id: PRICE_WAR.id,
          change_id: OPENAI_CUT.id,
          verdict: 'competitive',
          rationale:
            'gpt-6-astra is still the flagship; output falls from 50 to 30 with no successor in the records, a cut of 40.',
        },
        {
          claim_id: SAFETY.id,
          change_id: LONG_OUTAGE.id,
          verdict: 'material',
          rationale: '"Elevated errors on Claude API" at major impact for 3.5 hours.',
        },
        // Not a candidate: gpt-6-luna is not the flagship.
        {
          claim_id: PRICE_WAR.id,
          change_id: NON_FLAGSHIP_CUT.id,
          verdict: 'competitive',
          rationale: 'A cut.',
        },
        // Ungrounded number.
        {
          claim_id: SAFETY.id,
          change_id: LONG_OUTAGE.id,
          verdict: 'material',
          rationale: 'Down for 9 hours.',
        },
        // Verdict the claim does not allow.
        {
          claim_id: PRICE_WAR.id,
          change_id: OPENAI_CUT.id,
          verdict: 'aggressive',
          rationale: 'A cut.',
        },
      ],
    }
    const report = await submitJudgeRun(db, JSON.stringify(body), {
      now: new Date('2026-10-10T07:00:00Z'),
      sourcesYaml,
    })
    expect(report.claims.accepted).toBe(2)
    expect(report.claims.inserted).toBe(2)
    expect(report.claims.rejected.map((r) => r.reason)).toEqual([
      'not-a-candidate',
      'ungrounded-number',
      'unknown-verdict',
    ])

    const data = await queryTheses(
      db,
      queryContext(sourcesYaml, 'x', () => new Date('2026-10-10T08:00:00Z')),
    )
    const byId = Object.fromEntries(data.theses[0]!.claims.map((c) => [c.id, c]))
    expect(byId[PRICE_WAR.id]!.status).toBe('weakening')
    expect(byId[PRICE_WAR.id]!.verdicts[0]!.facts.cut_pct).toBe(40)
    expect(byId[SAFETY.id]!.status).toBe('weakening')
    expect(byId[SAFETY.id]!.verdicts[0]!.confirmation).toBeNull()

    const log = await db.select().from(schema.claimStatusChanges)
    expect(log.map((r) => [r.claim_id, r.status]).sort()).toEqual([
      [PRICE_WAR.id, 'weakening'],
      [SAFETY.id, 'weakening'],
    ])
  })

  it('rates a subject once: a second run over the same incident inserts nothing', async () => {
    const body = {
      alerts: [],
      judged_through: '2026-10-10T06:00:00Z',
      change_ids_seen: [LONG_OUTAGE.id],
      claims: [
        {
          claim_id: SAFETY.id,
          change_id: LONG_OUTAGE.id,
          verdict: 'not-material',
          rationale: '"Elevated errors on Claude API".',
        },
      ],
    }
    const report = await submitJudgeRun(db, JSON.stringify(body), { sourcesYaml })
    expect(report.claims).toMatchObject({ accepted: 1, inserted: 0 })
  })
})

describe('thesis definitions', () => {
  it('gives every judged claim a rubric and a judged_from date', () => {
    const judged = ANTHROPIC_THESIS.claims.filter(
      (c): c is ClaimDef & { spec: JudgedSpec } => c.spec.kind === 'judged',
    )
    expect(judged.map((c) => c.n)).toEqual([3, 5])
    for (const c of judged) {
      expect(c.spec.rubric.length).toBeGreaterThan(40)
      expect(c.spec.judged_from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('is a valid ThesisDef for every thesis', () => {
    const t: ThesisDef = ANTHROPIC_THESIS
    expect(t.comparison_set).not.toContain(t.company)
  })
})
