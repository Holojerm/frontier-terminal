import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import type { ForwardCall } from '../shared/utils/signals'
import { contentHash } from '../server/pipeline/contracts'
import {
  allCalls,
  callRange,
  forwardCallViews,
  recordCalls,
  resolveForwardCalls,
} from '../server/signals/forward-calls'
import { REGISTERED_CALLS } from '../server/signals/forward-calls-registered'
import lock from '../server/signals/forward-calls.lock.json'
import { forwardConceptNeeds } from '../server/signals/forward-filers'
import {
  guidanceBiasCalls,
  printRatioCalls,
  runForwardCalls,
} from '../server/signals/forward-rules'

// Forward calls: the registered ones never change, rows are only inserted,
// a call settles against a filing made after it, and the rules record the
// calls they should from guidance and prints.

const db = drizzle(env.DB, { schema })
const APP = 'https://frontierterm.com'
const NONE = { providers: [] }
const NOW = new Date('2026-11-22T07:10:00Z')

beforeEach(async () => {
  for (const t of [
    schema.forwardCalls,
    schema.forwardCallScores,
    schema.filedFacts,
    schema.filedGuidance,
    schema.guidanceResolutions,
    schema.hardwarePrints,
  ]) {
    await db.delete(t)
  }
})

describe('registered calls', () => {
  it('match the lock: a recorded call is never edited or removed', () => {
    const locked = lock as Record<string, string>
    for (const [id, hash] of Object.entries(locked)) {
      const call = REGISTERED_CALLS.find((c) => c.id === id)
      expect(call, `${id} was removed`).toBeDefined()
      expect(contentHash(call), `${id} changed after it was recorded`).toBe(hash)
    }
    for (const c of REGISTERED_CALLS) {
      expect(locked[c.id], `add "${c.id}": "${contentHash(c)}" to forward-calls.lock.json`).toBe(
        contentHash(c),
      )
    }
  })

  it('have unique ids, at least one method each and a period not filed when recorded', () => {
    expect(new Set(REGISTERED_CALLS.map((c) => c.id)).size).toBe(REGISTERED_CALLS.length)
    for (const c of REGISTERED_CALLS) {
      expect(c.methods.length).toBeGreaterThan(0)
      expect(c.period.end > c.recorded.slice(0, 10) || c.id === 'cien-revenue-fy2026q4').toBe(true)
    }
  })
})

// Every server file, as text.
const SERVER = import.meta.glob(['/server/**/*.ts', '/layers/*/server/**/*.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

describe('rows are only inserted', () => {
  it('no server code updates or deletes a forward call or score', () => {
    expect(Object.keys(SERVER).length).toBeGreaterThan(100)
    let inserts = 0
    for (const [f, text] of Object.entries(SERVER)) {
      expect(text, f).not.toMatch(/\.(update|delete)\((tables|schema)\.forwardCall(s|Scores)\b/)
      expect(text, f).not.toMatch(/(update|delete\s+from|replace\s+into)\s+["`]?forward_call/i)
      for (const m of text.matchAll(/\.insert\((tables|schema)\.forwardCall(s|Scores)\)/g)) {
        inserts++
        expect(text.slice(m.index, m.index + 160), f).toContain('onConflictDoNothing')
      }
    }
    expect(inserts).toBe(2)
  })

  it('a call recorded twice keeps its first row', async () => {
    const first = REGISTERED_CALLS[1]!
    await recordCalls(db, [first], APP, NOW)
    const edited: ForwardCall = { ...first, methods: [{ ...first.methods[0]!, value: 1 }] }
    expect(await recordCalls(db, [edited], APP, NOW)).toBe(0)
    const [row] = await db.select().from(schema.forwardCalls)
    expect(JSON.parse(row!.methods)[0].value).toBe(first.methods[0]!.value)
  })
})

const fact = (over: Partial<typeof schema.filedFacts.$inferInsert>) => ({
  id: `f-${Math.random().toString(36).slice(2)}`,
  ticker: 'CRWV',
  cik: '0001769628',
  concept: 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax',
  dims: '',
  start: '2026-10-01',
  end: '2026-12-31',
  value: 4.2e9,
  unit: 'USD',
  form: '10-K',
  filed: '2027-03-01',
  accession_no: '0001769628-27-000010',
  basis: 'companyconcept',
  raw_key: 'k',
  first_seen_at: '2027-03-02T00:00:00Z',
  source_url: 'https://data.sec.gov/x',
  fetched_at: '2027-03-02T00:00:00Z',
  ...over,
})

const call = (over: Partial<ForwardCall> = {}): ForwardCall => ({
  id: 'crwv-test',
  rule: 'hand',
  kind: 'forecast',
  ticker: 'CRWV',
  metric: 'revenue',
  fiscal_year: 2026,
  fiscal_quarter: 4,
  period: { start: '2026-10-01', end: '2026-12-31' },
  label: 'CoreWeave revenue, Q4 2026',
  resolves_from: 'us-gaap:Revenues,us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax',
  methods: [
    { method: 'Guide', value: 4e9, low: 3.5e9, high: 4.5e9, control: false },
    { method: 'Flat', value: 3.6e9, low: null, high: null, control: false },
    { method: 'Control', value: 9e9, low: null, high: null, control: true },
  ],
  inputs: [],
  note: '',
  recorded: '2026-11-21',
  ...over,
})

describe('settling', () => {
  it('scores each method against a filing made after the call', async () => {
    await recordCalls(db, [call()], APP, NOW)
    await db.insert(schema.filedFacts).values(fact({}))
    // The registered CoreWeave call for the same quarter settles too.
    expect(await resolveForwardCalls(db, NONE, new Date('2027-03-05T00:00:00Z'))).toBe(2)
    const scores = (await db.select().from(schema.forwardCallScores)).filter(
      (s) => s.call_id === 'crwv-test',
    )
    expect(scores).toHaveLength(3)
    const guide = scores.find((s) => s.method === 'Guide')!
    expect(guide.error_pct).toBeCloseTo((4 / 4.2 - 1) * 100, 6)
    expect(guide.in_method_range).toBe(1)
    expect(guide.in_call_range).toBe(1)
    expect(scores.find((s) => s.method === 'Flat')!.in_method_range).toBeNull()
    expect(guide.source_url).toBe(
      'https://www.sec.gov/Archives/edgar/data/1769628/000176962827000010/',
    )
    // Settled once.
    expect(await resolveForwardCalls(db, NONE, new Date('2027-03-06T00:00:00Z'))).toBe(0)
    const view = (await forwardCallViews(db)).find((v) => v.id === 'crwv-test')!
    expect(view.actual).toMatchObject({ value: 4.2e9, form: '10-K', in_range: true })
    expect(view.methods[0]).toMatchObject({ in_range: true })
  })

  it('never scores against a figure filed before the call was recorded', async () => {
    await recordCalls(db, [call({ recorded: '2027-03-01' })], APP, NOW)
    await db.insert(schema.filedFacts).values(fact({}))
    await resolveForwardCalls(db, NONE, new Date('2027-03-05T00:00:00Z'))
    const scores = await db.select().from(schema.forwardCallScores)
    expect(scores.some((s) => s.call_id === 'crwv-test')).toBe(false)
  })

  it('settles a lab’s call from its filed revenue', async () => {
    const ant = REGISTERED_CALLS.find((c) => c.id === 'ant-revenue-2026q4')!
    const period = {
      start: '2026-10-01',
      end: '2026-12-31',
      days: 92,
      val: 20e9,
      filed: '2027-02-20',
      form: '10-K',
      accession_no: 'a',
      filing_url: 'https://www.sec.gov/ant',
      unaudited: false,
      source_url: 's',
      fetched_at: 'f',
    }
    const revenue = { providers: [{ provider: 'anthropic', periods: [period], superseded: [] }] }
    const n = await resolveForwardCalls(
      db,
      revenue as unknown as Parameters<typeof resolveForwardCalls>[1],
      new Date('2027-02-21T00:00:00Z'),
    )
    expect(n).toBe(1)
    const scores = await db.select().from(schema.forwardCallScores)
    expect(scores.every((s) => s.call_id === ant.id && s.actual === 20e9)).toBe(true)
    // 17.3 to 20.3 to 28.1: the controls don't widen the range.
    expect(callRange(ant)).toEqual([17.3e9, 28.1e9])
    expect(scores[0]!.in_call_range).toBe(1)
  })

  it('asks the call reader for the concepts of a call whose period has ended', async () => {
    await recordCalls(db, [call()], APP, NOW)
    const needs = await forwardConceptNeeds(db, '2027-01-05')
    expect(needs).toContainEqual({
      ticker: 'CRWV',
      concept: 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax',
    })
    // A prints rule's revenue, every day.
    expect(needs.some((n) => n.ticker === 'MU')).toBe(true)
  })
})

const guidance = (over: Partial<typeof schema.filedGuidance.$inferInsert>) => ({
  id: `g-${Math.random().toString(36).slice(2)}`,
  ticker: 'CRWV',
  cik: '0001769628',
  accession_no: '',
  filed: '2026-11-12',
  fiscal_year: 2026,
  low: 15e9,
  high: 16e9,
  sentence: 'We expect revenue of $15 to $16 billion for the year.',
  raw_key: 'k',
  first_seen_at: '2026-11-25T00:00:00Z',
  source: 'transcript',
  metric: 'revenue',
  unit: 'USD',
  bound: 'range',
  fiscal_quarter: null,
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  page_url: 'https://investors.coreweave.com/',
  method: 'parser',
  source_url: 'https://investors.coreweave.com/t.pdf',
  fetched_at: '2026-11-25T00:00:00Z',
  ...over,
})

const resolution = (guidance_id: string, error_share: number, filed: string) => ({
  id: `r-${guidance_id}`,
  guidance_id,
  ticker: 'CRWV',
  metric: 'revenue',
  actual: 1,
  guided_mid: 1,
  error_share,
  state: 'above',
  concept: 'c',
  form: '10-Q',
  filed,
  accession_no: 'a',
  first_seen_at: 'x',
  source_url: 's',
  fetched_at: 'f',
})

describe('the guidance rule', () => {
  it('turns a year’s guide with three quarters filed into a call on the fourth, with its bias', async () => {
    const quarters = [
      ['2026-01-01', '2026-03-31', 2e9],
      ['2026-04-01', '2026-06-30', 3e9],
      ['2026-07-01', '2026-09-30', 4e9],
    ] as const
    await db.insert(schema.filedFacts).values(
      quarters.map(([start, end, value], i) =>
        fact({
          start,
          end,
          value,
          form: '10-Q',
          filed: `2026-0${5 + i}-10`,
          accession_no: `q${i}`,
        }),
      ),
    )
    const past = [
      guidance({
        filed: '2026-02-26',
        first_seen_at: '2026-11-20T00:00:00Z',
        period_start: '2026-01-01',
        period_end: '2026-03-31',
        fiscal_quarter: 1,
      }),
      guidance({
        filed: '2026-05-07',
        first_seen_at: '2026-11-20T00:00:00Z',
        period_start: '2026-04-01',
        period_end: '2026-06-30',
        fiscal_quarter: 2,
      }),
    ]
    const open = guidance({})
    await db.insert(schema.filedGuidance).values([...past, open])
    await db
      .insert(schema.guidanceResolutions)
      .values([
        resolution(past[0]!.id, 0.02, '2026-05-10'),
        resolution(past[1]!.id, 0.06, '2026-08-10'),
      ])
    const calls = await guidanceBiasCalls(db, new Date('2026-11-26T07:10:00Z'))
    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c).toMatchObject({
      id: 'gb-crwv-revenue-2026-12-31-2026-11-12',
      rule: 'guidance-bias',
      fiscal_quarter: 4,
      period: { start: '2026-10-01', end: '2026-12-31' },
      label: 'CoreWeave revenue, Q4 2026',
    })
    expect(c.methods[0]).toMatchObject({ value: 6.5e9, low: 6e9, high: 7e9 })
    // The median of +2% and +6%.
    expect(c.methods[1]!.value).toBeCloseTo(15.5e9 * 1.04 - 9e9, 0)
    expect(c.methods).toHaveLength(2)
  })

  it('leaves out guidance read before the rule began, a period already over and a misread', async () => {
    await db
      .insert(schema.filedFacts)
      .values(fact({ start: '2026-07-01', end: '2026-09-30', value: 4e9, filed: '2026-11-12' }))
    await db
      .insert(schema.filedGuidance)
      .values([
        guidance({ first_seen_at: '2026-11-21T00:00:00Z' }),
        guidance({ period_end: '2026-09-30', period_start: '2026-07-01', fiscal_quarter: 3 }),
        guidance({ low: 0.9e9, high: 1.1e9, fiscal_quarter: 4, period_start: '2026-10-01' }),
      ])
    expect(await guidanceBiasCalls(db, new Date('2026-11-26T07:10:00Z'))).toEqual([])
  })
})

const print = (period: string, window: string, value: number, source_id = 'kcs-chip-exports') => ({
  id: `p-${period}-${window}-${source_id}`,
  series: 'kr_chip_exports',
  entity: 'kr-semiconductors',
  ticker: null,
  period,
  window,
  value,
  currency: 'USD',
  yoy_pct: null,
  observed_as: 'print',
  vintage: 1,
  first_seen_at: `${period}-28T00:00:00Z`,
  published_at: null,
  due_on: null,
  basis: 'live',
  source_id,
  raw_key: null,
  source_url: 'https://www.customs.go.kr/x',
  fetched_at: `${period}-28T00:00:00Z`,
})

const muRevenue = (start: string, end: string, value: number) =>
  fact({
    ticker: 'MU',
    cik: '0000723125',
    start,
    end,
    value,
    form: '10-Q',
    filed: end.replace(/-\d\d$/, '-28'),
    accession_no: `mu-${end}`,
  })

describe('the prints rule', () => {
  it('records Micron’s quarter from Korea’s chip exports once the months are in', async () => {
    // Four filed quarters at a steady 1.5× the quarter's exports.
    const quarters = [
      ['2025-09-01', '2025-11-30'],
      ['2025-12-01', '2026-02-28'],
      ['2026-03-01', '2026-05-31'],
      ['2026-06-01', '2026-08-31'],
    ] as const
    const months = [
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ]
    for (const [i, m] of months.entries()) {
      await db
        .insert(schema.hardwarePrints)
        .values(
          print(
            m,
            'month',
            10e9 + i * 1e9,
            i < 13 ? 'kcs-chip-exports-unmarked' : 'kcs-chip-exports',
          ),
        )
    }
    await db
      .insert(schema.filedFacts)
      .values(
        quarters.map(([s, e], k) => muRevenue(s, e, 1.5 * (3 * 10e9 + (3 * k * 3 + 3) * 1e9))),
      )
    const calls = await printRatioCalls(db, new Date('2026-12-02T07:10:00Z'))
    const mu = calls.find((c) => c.ticker === 'MU')!
    expect(mu).toMatchObject({
      id: 'pr-mu-kr-semiconductors-month-2026-11-30',
      label: 'Micron revenue, Q1 FY2027',
      period: { start: '2026-09-01', end: '2026-11-30' },
    })
    const exports = 22e9 + 23e9 + 24e9
    expect(mu.methods[0]!.value).toBeCloseTo(1.5 * exports, -3)
    // September's figure is held: no value shown.
    expect(mu.inputs[0]).toMatchObject({ value: null })
    expect(mu.inputs[1]!.value).toBe(23e9)
    // Recorded once: the same id the next day.
    await recordCalls(db, calls, APP, NOW)
    expect(
      await recordCalls(db, await printRatioCalls(db, new Date('2026-12-03T07:10:00Z')), APP, NOW),
    ).toBe(0)
  })

  it('records an early call from the last month’s 20-day print, before the quarter ends', async () => {
    const months = [
      '2024-11',
      '2024-12',
      '2025-01',
      '2025-02',
      '2025-03',
      '2025-04',
      '2025-05',
      '2025-06',
      '2025-07',
      '2025-08',
      '2025-09',
      '2025-10',
      '2025-11',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ]
    for (const m of months) await db.insert(schema.hardwarePrints).values(print(m, 'month', 30e9))
    for (const m of months.slice(0, 13))
      await db.insert(schema.hardwarePrints).values(print(m, 'd20', 20e9))
    await db.insert(schema.hardwarePrints).values(print('2026-11', 'd20', 22e9))
    await db.insert(schema.filedFacts).values(muRevenue('2026-06-01', '2026-08-31', 54e9))
    const calls = await printRatioCalls(db, new Date('2026-11-22T07:10:00Z'))
    const early = calls.find((c) => c.id === 'pr-mu-kr-semiconductors-d20-2026-11-30')!
    // November at 1.5 times its first 20 days: 30 + 30 + 33.
    expect(early.methods.find((m) => m.method.startsWith('Last quarter grown'))).toBeDefined()
    expect(early.inputs.at(-1)).toMatchObject({ value: 1.5, unit: 'ratio' })
  })

  it('records nothing once the quarter has been out too long', async () => {
    expect(await printRatioCalls(db, new Date('2027-01-05T07:10:00Z'))).toEqual([])
  })
})

describe('the daily step', () => {
  it('copies the registered calls in and lists each one', async () => {
    const report = await runForwardCalls(db, {
      revenue: NONE,
      now: new Date('2026-11-22T07:10:00Z'),
      appUrl: APP,
    })
    expect(report.recorded).toBe(REGISTERED_CALLS.length)
    expect((await allCalls(db)).length).toBe(REGISTERED_CALLS.length)
    const views = await forwardCallViews(db)
    expect(views.map((v) => v.id).sort()).toEqual(REGISTERED_CALLS.map((c) => c.id).sort())
    expect(views.every((v) => v.actual === null)).toBe(true)
  })
})
