import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { ChangeRow, contentHash } from '../../server/pipeline/contracts'
import { incidentCounts } from '../../server/pipeline/judge/pending'
import { clampRoutineAlerts } from '../../server/pipeline/judge/severity-gates'
import { submitJudgeRun } from '../../server/pipeline/judge/submit'
import { modelFloorAlerts } from '../../server/pipeline/model-floor'
import {
  EIGHT_K_ITEMS_FROM,
  parseEdgarSubmissions,
} from '../../server/pipeline/parsers/sec/edgar-submissions'
import { eightKItems, isRoutine8K } from '../../server/pipeline/parsers/sec/forms'
import { parseCikWhitelistBlock } from '../../server/pipeline/parsers/sec/whitelist'
import { insertRows } from '../../server/pipeline/store'
import { fixtureText } from './fixtures'

// The severity rules outside the hiring floor: routine 8-Ks and minor price
// moves stored as ticker lines, the incident window, and the model floor's
// memory of slugs a catalog has dropped.

const db = drizzle(env.DB, { schema })
const AT = '2026-11-09T18:00:00.000Z'
const URL = 'https://example.com/source'

let seq = 0
function change(
  entity_type: string,
  change_type: 'added' | 'removed' | 'modified',
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  detected_at = AT,
  provider = 'openai',
): ChangeRow {
  const n = ++seq
  return ChangeRow.parse({
    id: contentHash({ n }),
    entity_key: `${entity_type}:${provider}:${n}`,
    entity_type,
    provider,
    change_type,
    before_hash: before ? contentHash(before) : null,
    after_hash: after ? contentHash(after) : null,
    before_json: before ? JSON.stringify(before) : null,
    after_json: after ? JSON.stringify(after) : null,
    detected_at,
    source_url: URL,
    fetched_at: detected_at,
  })
}

const price = (model_slug: string, tier: string | null, input: number, output: number) => ({
  provider: 'openai',
  model_slug,
  tier,
  context_window: null,
  input_per_mtok: input,
  cached_input_per_mtok: null,
  output_per_mtok: output,
  currency: 'USD',
  effective_from: null,
  effective_until: null,
  notes: null,
})

const eightK = (items?: string[]) => ({
  accession_no: `acc-${++seq}`,
  form: '8-K',
  file_date: '2026-11-09',
  ciks: ['0000789019'],
  display_names: ['MICROSOFT CORP'],
  whitelist_cik: '0000789019',
  ...(items ? { items } : {}),
})

const alertOn = (...cited: ChangeRow[]) => ({
  severity: 'notable' as const,
  headline: 'A headline',
  change_ids: cited.map((c) => c.id),
})

const TRACKED = new Set(['openai:gpt-flagship'])
const gate = (...cited: ChangeRow[]) =>
  clampRoutineAlerts([alertOn(...cited)], cited, TRACKED).alerts[0]!.severity

describe('8-K items', () => {
  it('captions known items and keeps unknown numbers bare', () => {
    expect(eightKItems('2.02, 9.01,6.05')).toEqual([
      '2.02 Results of Operations and Financial Condition',
      '9.01 Financial Statements and Exhibits',
      '6.05',
    ])
    expect(eightKItems('')).toEqual([])
  })

  it('calls an 8-K routine only when every item is', () => {
    expect(isRoutine8K(eightKItems('7.01,9.01'))).toBe(true)
    expect(isRoutine8K(eightKItems('1.01,9.01'))).toBe(false)
    expect(isRoutine8K([])).toBe(false)
  })

  it('stores a routine 8-K as info, and leaves one with no items to the judge', () => {
    expect(gate(change('filing', 'added', null, eightK(eightKItems('8.01'))))).toBe('info')
    expect(gate(change('filing', 'added', null, eightK(eightKItems('5.02'))))).toBe('notable')
    expect(gate(change('filing', 'added', null, eightK()))).toBe('notable')
  })
})

describe('8-K items on the submissions feed', () => {
  it('sets them from the cutoff only, so stored filings do not diff', () => {
    const { rows } = parseEdgarSubmissions(
      JSON.stringify({
        cik: '789019',
        name: 'MICROSOFT CORP',
        filings: {
          recent: {
            accessionNumber: ['new', 'old', 'report'],
            form: ['8-K', '8-K', '10-Q'],
            filingDate: [EIGHT_K_ITEMS_FROM, '2026-11-08', EIGHT_K_ITEMS_FROM],
            items: ['2.02,9.01', '5.02', ''],
          },
        },
      }),
      parseCikWhitelistBlock(fixtureText('sources.yaml')),
      { source_url: URL, fetched_at: AT },
    )
    const by = new Map(rows.map((r) => [r.accession_no, r]))
    expect(by.get('new')?.items).toEqual(eightKItems('2.02,9.01'))
    expect(by.get('old')).not.toHaveProperty('items')
    expect(by.get('report')).not.toHaveProperty('items')
  })
})

describe('pricing materiality', () => {
  const was = price('gpt-mini', null, 1, 2)

  it('lowers discount-tier, cached-only and delisting moves on untracked models', () => {
    const batch = price('gpt-mini', 'batch', 0.5, 1)
    expect(gate(change('model', 'modified', batch, { ...batch, input_per_mtok: 0.4 }))).toBe('info')
    expect(gate(change('model', 'modified', was, { ...was, cached_input_per_mtok: 0.1 }))).toBe(
      'info',
    )
    expect(gate(change('model', 'removed', was, null))).toBe('info')
  })

  it('keeps a list-price change, a new SKU, and anything on a tracked model', () => {
    const flagship = price('gpt-flagship', 'batch', 5, 10)
    expect(gate(change('model', 'modified', was, { ...was, output_per_mtok: 3 }))).toBe('notable')
    expect(gate(change('model', 'added', null, price('gpt-new', 'batch', 1, 2)))).toBe('notable')
    expect(gate(change('model', 'removed', flagship, null))).toBe('notable')
  })

  it('keeps an alert that also cites something the rules do not cover', () => {
    const minor = change('model', 'removed', was, null)
    const launch = change('model', 'added', null, price('gpt-new', null, 1, 2))
    expect(gate(minor, launch)).toBe('notable')
  })
})

describe('with the database', () => {
  beforeEach(async () => {
    await db.delete(schema.alerts)
    await db.delete(schema.changes)
    await db.delete(schema.judgeRuns)
  })

  it('applies the gates at the submit gate and reports them', async () => {
    const filing = change('filing', 'added', null, eightK(eightKItems('7.01,9.01')))
    await insertRows(db, 'changes', [filing])
    const report = await submitJudgeRun(
      db,
      JSON.stringify({
        alerts: [
          {
            severity: 'notable',
            headline: 'MICROSOFT CORP files an 8-K',
            explanation: 'MICROSOFT CORP filed an 8-K.',
            change_ids: [filing.id],
          },
        ],
        judged_through: AT,
        change_ids_seen: [filing.id],
      }),
      { clusters: [], now: new Date('2026-11-09T19:00:00Z') },
    )
    expect(report.clamped).toEqual([
      {
        headline: 'MICROSOFT CORP files an 8-K',
        from: 'notable',
        to: 'info',
        detail: 'an 8-K with routine items only',
      },
    ])
    const [stored] = await db.select().from(schema.alerts)
    expect(stored?.severity).toBe('info')
  })

  it('counts added incidents over the window, only when one is pending', async () => {
    const now = new Date(AT)
    const recent = change('incident', 'added', null, { title: 'a' }, '2026-11-09T06:00:00.000Z')
    const old = change('incident', 'added', null, { title: 'b' }, '2026-11-07T06:00:00.000Z')
    await insertRows(db, 'changes', [recent, old])

    expect(await incidentCounts(db, [recent], now)).toEqual({
      window_hours: 24,
      providers: [{ provider: 'openai', added: 1 }],
    })
    expect(await incidentCounts(db, [], now)).toEqual({ window_hours: 24, providers: [] })
  })

  const listed = (slug: string, detected_at = AT) =>
    change('model', 'added', null, price(slug, null, 1, 2), detected_at)

  it('announces a slug nothing has listed', async () => {
    const [alert, ...rest] = await modelFloorAlerts(db, 'src', [listed('gpt-brand-new')])
    expect(rest).toEqual([])
    expect(alert!.headline).toContain('gpt-brand-new')
  })

  it('does not announce a slug the change log already added', async () => {
    await insertRows(db, 'changes', [listed('gpt-returning', '2026-08-25T22:16:00.000Z')])
    expect(await modelFloorAlerts(db, 'src', [listed('gpt-returning')])).toEqual([])
  })

  it('does not announce a parser reading a table cell as a slug', async () => {
    expect(await modelFloorAlerts(db, 'src', [listed('gpt-5-(for-prompts-over-100,000)')])).toEqual(
      [],
    )
  })
})
