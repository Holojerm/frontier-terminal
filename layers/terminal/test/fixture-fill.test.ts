import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { fillFromFixtures, type FixtureFillReport } from '../server/dev/fixture-fill'
import { fixtureText } from '#layers/core/test/pipeline/fixtures'

// The offline fill, as dev:fixtures and the browser suites run it. The suites
// sweep whatever the fill stores, so a page whose rows the fill stops reaching
// would go back to being checked as an empty state with every gate green.
// These pin the rows the filed-figure pages need: /exposure, /dependencies,
// /ground-truth and /revenue.

// Six polls of every fixture source, then the recipes and theses, in workerd.
const FILL = 120_000

const sourcesYaml = fixtureText('sources.yaml')
const raw: RawStore = {
  put: async (key, body, contentType) => {
    await env.BLOB.put(key, body, { httpMetadata: { contentType } })
  },
}

const memoryLock = (): LockStore => {
  let value: string | null = null
  return {
    get: async () => value,
    put: async (_k, v) => {
      value = v
    },
    delete: async () => {
      value = null
    },
  }
}

// Advances a second per read, so the time-derived snapshot ids stay unique.
let clock = Date.parse('2026-11-20T02:00:00Z')
const now = () => new Date((clock += 1000))
const ctx = () => queryContext(sourcesYaml, null, now)

let report: FixtureFillReport

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  report = await fillFromFixtures({
    db,
    raw,
    readRaw: async (key) => (await env.BLOB.get(key))?.text() ?? null,
    lock: memoryLock(),
    sourcesYaml,
    read: fixtureText,
    now,
    surveyLockRetry: { retries: 0, delayMs: 0 },
  })
}, FILL)

describe('the fixture fill', () => {
  it('runs every poll and reads every filed-facts document it asks for', () => {
    expect(report.polls.map((p) => p.status)).toEqual(report.polls.map(() => 'ran'))
    expect(report.filed_facts.deferred).toBe(0)
    const failed = report.filed_facts.reads.filter((r) => r.status === 'failed')
    expect(failed).toEqual([])
    const kinds = (kind: string) => report.filed_facts.reads.filter((r) => r.kind === kind)
    expect(kinds('companyfacts').map((r) => r.ticker)).toEqual([
      'MSFT',
      'GOOGL',
      'AMZN',
      'META',
      'ORCL',
    ])
    expect(kinds('instance').map((r) => r.ticker)).toEqual(['MSFT', 'GOOGL', 'AMZN'])
    expect(kinds('release').map((r) => r.ticker)).toEqual(['GOOGL', 'AMZN', 'META', 'ORCL'])
  })

  it('gives /exposure a series per filer and the facts on each lab', async () => {
    const { filers, series } = await queryExposure(db, ctx())
    expect(filers.map((f) => f.ticker).sort()).toEqual(['AMZN', 'GOOGL', 'META', 'MSFT', 'ORCL'])
    for (const f of filers) expect(series.some((s) => s.ticker === f.ticker)).toBe(true)
    expect(series.some((s) => s.group === 'openai' && s.ticker === 'MSFT')).toBe(true)
    expect(series.some((s) => s.group === 'anthropic' && s.ticker === 'AMZN')).toBe(true)
  })

  it('gives /revenue a lab’s prospectus, both registration filings read', async () => {
    const { issuers } = await queryProspectus(db, ctx())
    expect(issuers.map((i) => i.provider)).toEqual(['anthropic'])
    const [anthropic] = issuers
    expect(anthropic!.filings.map((f) => f.form)).toEqual(['S-1/A', 'S-1'])
    expect(anthropic!.statement.lines.length).toBeGreaterThan(0)
    expect(anthropic!.commitments.length).toBeGreaterThan(0)
    expect(anthropic!.concentration.length).toBeGreaterThan(0)
    expect(anthropic!.risk_factors.latest.sections.length).toBeGreaterThan(0)
    expect(anthropic!.risk_factors.diffs.length).toBeGreaterThan(0)

    const revenue = await queryRevenue(db, ctx())
    const lab = revenue.providers.find((p) => p.provider === 'anthropic')
    expect(lab?.periods.length).toBeGreaterThan(0)
  })

  it('gives /dependencies a line in each direction and a sized lab', async () => {
    const { nodes, edges } = await queryDependencies(db, ctx())
    expect(edges.some((e) => e.kind === 'buys')).toBe(true)
    expect(edges.some((e) => e.kind === 'funds')).toBe(true)
    expect(edges.map((e) => e.id)).toEqual(
      expect.arrayContaining(['MSFT>openai:funds', 'AMZN>anthropic:funds']),
    )
    expect(nodes.find((n) => n.id === 'anthropic')?.contracts?.value).toBeGreaterThan(0)
    expect(nodes.find((n) => n.id === 'MSFT')?.capex?.value).toBeGreaterThan(0)
  })

  it('gives /ground-truth guidance to score against a filed year', async () => {
    const { guidance } = await queryGroundTruth(db, ctx())
    expect(guidance.rows.map((r) => r.ticker).sort()).toEqual(['AMZN', 'GOOGL', 'META', 'ORCL'])
  })
})
