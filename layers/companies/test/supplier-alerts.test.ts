import { beforeEach, describe, expect, it } from 'vitest'

import {
  FRESH_DAYS,
  SUPPLIER_RULE,
  newPassages,
  supplierFindings,
  writeSupplierAlerts,
} from '../server/suppliers/alerts'
import { applySupplierReview } from '../server/suppliers/review'
import { relabelPassages } from '../server/suppliers/store'
import { JUDGE_EXCLUDED_ENTITY_TYPES } from '#layers/core/server/pipeline/judge/pending'

// The supplier-passage rule over made-up AMD and Credo filings. Every company, accession and
// figure here is invented.

type Passage = typeof schema.supplierPassages.$inferSelect
type Doc = typeof schema.supplierDocuments.$inferSelect

const NOW = new Date('2026-11-25T12:00:00Z')
const DAY = 86_400_000
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)
const dayAgo = (days: number) => ago(days).toISOString().slice(0, 10)

let n = 0
function doc(ticker: string, form: string, filed: string, fetchedAt: string): Doc {
  n += 1
  const accession_no = `0000000001-26-${String(n).padStart(6, '0')}`
  return {
    accession_no,
    ticker,
    form,
    filed,
    report_date: null,
    status: 'read',
    detail: null,
    raw_key: `suppliers/${ticker.toLowerCase()}/${accession_no}.htm`,
    excerpts: 1,
    judged_at: fetchedAt,
    source_url: `https://www.sec.gov/Archives/edgar/data/1/${accession_no.replace(/-/g, '')}/x.htm`,
    fetched_at: fetchedAt,
  }
}

function passage(
  d: Pick<Doc, 'ticker' | 'form' | 'filed' | 'accession_no' | 'source_url'>,
  over: Partial<Passage> & Pick<Passage, 'quote' | 'first_seen_at'>,
): Passage {
  n += 1
  return {
    id: String(n).padStart(64, '0'),
    ticker: d.ticker,
    company_name: d.ticker === 'AMD' ? 'AMD' : 'Credo',
    layer: 'chips',
    relation: 'customer',
    counterparty: 'Anthropic',
    counterparty_ticker: null,
    counterparty_lab: 'anthropic',
    figures: '[]',
    form: d.form,
    filed: d.filed,
    period: null,
    source_title: `${d.ticker} ${d.form}, filed ${d.filed}`,
    alias_term: null,
    alias_quote: null,
    basis: 'judge',
    accession_no: d.accession_no,
    ended_at: null,
    ended_by: null,
    source_url: d.source_url,
    fetched_at: over.first_seen_at,
    ...over,
  }
}

const usd = (value: number, meaning = 'GPU purchase commitment') =>
  JSON.stringify([{ value, unit: 'usd', meaning }])

/** A hand-read AMD row from a year ago: the company is known to the reader. */
const HAND_DOC = doc('AMD', '10-K', '2025-11-01', '2026-11-20T02:00:00.000Z')
const HAND = passage(HAND_DOC, {
  basis: 'hand',
  counterparty: 'OpenAI',
  counterparty_lab: 'openai',
  figures: JSON.stringify([{ value: 6, unit: 'gw', meaning: 'GPUs OpenAI intends to deploy' }]),
  quote: 'We entered into an agreement with OpenAI to deploy 6 gigawatts of AMD GPUs.',
  first_seen_at: '2026-11-20T02:00:00.000Z',
})

const read = (days: number) => ago(days).toISOString()

describe('the supplier-passage rule, pure', () => {
  it('alerts once on a fresh filing with a new tie, notable with a figure', () => {
    const d = doc('AMD', '10-Q', dayAgo(3), read(2))
    const p = passage(d, {
      figures: usd(4.5e9),
      quote: 'Anthropic committed to purchase $4.5 billion of AMD Instinct GPUs through 2028.',
      first_seen_at: read(1),
    })
    const [f, ...rest] = supplierFindings([d], [HAND, p], new Map(), NOW)
    expect(rest).toEqual([])
    expect(f).toMatchObject({
      rule: SUPPLIER_RULE,
      entity_type: 'supplier_passage',
      entity_key: 'supplier_passage:amd',
      provider: 'anthropic',
      period: d.accession_no,
      severity: 'notable',
      source_url: d.source_url,
      fetched_at: d.fetched_at,
    })
    expect(f!.headline).toBe(`AMD’s 10-Q, filed ${d.filed}, says AMD sells to Anthropic ($4.50B)`)
    expect(f!.explanation).toContain(`“${p.quote}”`)
    expect(f!.explanation).not.toMatch(/—|;/)
  })

  it('is info for a tie with no figure, and for an unnamed customer’s share', () => {
    const d = doc('AMD', '8-K', dayAgo(2), read(2))
    const named = passage(d, {
      quote: 'We announced a multi-year collaboration with Anthropic on data center GPUs.',
      first_seen_at: read(1),
    })
    expect(supplierFindings([d], [HAND, named], new Map(), NOW)[0]?.severity).toBe('info')
    const q = doc('AMD', '10-Q', dayAgo(2), read(2))
    const share = passage(q, {
      relation: 'concentration',
      counterparty: 'Customer A',
      counterparty_lab: null,
      figures: JSON.stringify([{ value: 14, unit: 'pct_revenue', meaning: 'share of revenue' }]),
      quote: 'Customer A accounted for 14% of total net revenue for the quarter.',
      first_seen_at: read(1),
    })
    const [f] = supplierFindings([q], [HAND, share], new Map(), NOW)
    expect(f).toMatchObject({ severity: 'info', provider: 'other' })
  })

  it('leaves out a known tie restated, and alerts on a new figure for it', () => {
    const d = doc('AMD', '10-Q', dayAgo(3), read(2))
    const restated = passage(d, {
      counterparty: 'OpenAI',
      counterparty_lab: 'openai',
      figures: JSON.stringify([{ value: 6, unit: 'gw', meaning: 'GPUs OpenAI intends to deploy' }]),
      quote: 'OpenAI intends to deploy up to 6 gigawatts of AMD Instinct GPUs over several years.',
      first_seen_at: read(1),
    })
    expect(newPassages(d, [HAND, restated])).toEqual([])
    const raised = { ...restated, figures: usd(10e9, 'warrant value') }
    expect(newPassages(d, [HAND, raised])).toEqual([raised])
  })

  it('leaves out a row restamped onto the filing, read before it', () => {
    const d = doc('AMD', '10-K', dayAgo(3), read(2))
    const restamped = passage(d, {
      quote: 'Anthropic is a customer of our data center segment.',
      first_seen_at: read(30),
    })
    expect(supplierFindings([d], [HAND, restamped], new Map(), NOW)).toEqual([])
  })

  it('stays quiet once the filing is older than the window', () => {
    const d = doc('AMD', '10-Q', dayAgo(FRESH_DAYS + 1), read(1))
    const p = passage(d, {
      figures: usd(4.5e9),
      quote: 'Anthropic committed to purchase $4.5 billion of AMD Instinct GPUs through 2028.',
      first_seen_at: read(0),
    })
    expect(supplierFindings([d], [HAND, p], new Map(), NOW)).toEqual([])
  })

  it('alerts nothing for a company new to the reader until it has been read for the window', () => {
    const d = doc('CRDO', '8-K', dayAgo(1), read(1))
    const p = passage(d, {
      figures: usd(2e9),
      quote: 'Credo entered into a $2 billion supply agreement with Anthropic for active cables.',
      first_seen_at: read(0),
    })
    expect(supplierFindings([d], [p], new Map([['CRDO', read(1)]]), NOW)).toEqual([])
    const known = new Map([['CRDO', read(FRESH_DAYS + 5)]])
    expect(supplierFindings([d], [p], known, NOW)).toHaveLength(1)
  })

  it('gives two filings read in one run that state the same new tie one alert', () => {
    const k = doc('AMD', '8-K', dayAgo(6), read(1))
    const q = doc('AMD', '10-Q', dayAgo(3), read(1))
    const quote = 'Anthropic committed to purchase $4.5 billion of AMD Instinct GPUs through 2028.'
    const a = passage(k, { figures: usd(4.5e9), quote, first_seen_at: read(0) })
    const b = passage(q, {
      figures: usd(4.5e9),
      quote: `As disclosed, ${quote}`,
      first_seen_at: read(0),
    })
    const findings = supplierFindings([k, q], [HAND, a, b], new Map(), NOW)
    expect(findings.map((f) => f.period)).toEqual([k.accession_no])
  })

  it('reads several new passages of one filing as one alert naming each counterparty', () => {
    const d = doc('AMD', '10-Q', dayAgo(2), read(2))
    const passages = [
      passage(d, {
        figures: usd(4.5e9),
        quote: 'Anthropic committed to purchase $4.5 billion of AMD Instinct GPUs through 2028.',
        first_seen_at: read(1),
      }),
      passage(d, {
        counterparty: 'xAI',
        counterparty_lab: 'xai',
        quote: 'We began shipping MI500 systems to xAI for its Memphis data center.',
        first_seen_at: read(1),
      }),
      passage(d, {
        counterparty: 'Oracle',
        counterparty_lab: null,
        counterparty_ticker: 'ORCL',
        quote: 'Oracle will offer AMD Instinct GPUs in Oracle Cloud Infrastructure.',
        first_seen_at: read(1),
      }),
    ]
    const findings = supplierFindings([d], [HAND, ...passages], new Map(), NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.headline).toBe(
      `AMD’s 10-Q, filed ${d.filed}, names Anthropic, xAI, and Oracle in 3 new passages`,
    )
    expect(findings[0]!.explanation).toContain('And 1 more.')
    // Led by Anthropic, it also cites a row for xAI; the cloud tie adds none.
    expect(findings[0]!.provider).toBe('anthropic')
    expect(findings[0]!.also).toEqual([
      {
        provider: 'xai',
        after: expect.objectContaining({
          summary: `AMD · 10-Q · ${d.filed} · xAI · 1 new passage`,
          counterparty: 'xAI',
          labs: 'xai',
          passages: 1,
        }),
      },
    ])
  })

  it('cites no further row for a filing naming one lab', () => {
    const d = doc('AMD', '10-Q', dayAgo(2), read(2))
    const p = passage(d, {
      figures: usd(4.5e9),
      quote: 'Anthropic committed to purchase $4.5 billion of AMD Instinct GPUs through 2028.',
      first_seen_at: read(1),
    })
    expect(supplierFindings([d], [HAND, p], new Map(), NOW)[0]!.also).toEqual([])
  })
})

async function seed(docs: readonly Doc[], passages: readonly Passage[]) {
  for (const d of docs) await db.insert(schema.supplierDocuments).values(d)
  for (const p of passages) await db.insert(schema.supplierPassages).values(p)
}

describe('the supplier-passage rule over a seeded store', () => {
  beforeEach(async () => {
    for (const t of [
      schema.alerts,
      schema.alertCites,
      schema.changes,
      schema.supplierPassages,
      schema.supplierDocuments,
      schema.opsEvents,
    ]) {
      await db.delete(t)
    }
  })

  it('writes nothing for a backfill: a year of filings read and judged today', async () => {
    // The reader's first run: AMD and a filer new to it, 24 filings over a year, each read
    // today and each with a new tie. Only filings from the window could alert, and the new
    // filer's can't, so the fresh one here is Credo's.
    const docs: Doc[] = []
    const passages: Passage[] = [HAND]
    for (let i = 0; i < 24; i++) {
      const ticker = i % 2 ? 'AMD' : 'CRDO'
      const d = doc(ticker, i % 3 ? '8-K' : '10-Q', dayAgo(i === 0 ? 2 : 20 + i * 14), read(0.5))
      docs.push(d)
      passages.push(
        passage(d, {
          counterparty: ['OpenAI', 'Anthropic', 'xAI'][i % 3]!,
          counterparty_lab: (['openai', 'anthropic', 'xai'] as const)[i % 3],
          figures: usd((i + 1) * 1e9),
          quote: `Filing ${i} states a $${i + 1} billion agreement with a lab customer here.`,
          first_seen_at: read(0.25),
        }),
      )
    }
    await seed([HAND_DOC, ...docs], passages)
    expect(await writeSupplierAlerts(db, NOW)).toEqual({ written: 0, findings: 0 })
    expect(await db.select().from(schema.alerts)).toEqual([])
  })

  it('writes nothing on a first run over the stored history', async () => {
    // What the rule finds when it ships: hand-read rows and judge rows from filings read over
    // the past weeks, none filed in the window.
    const old = doc('AMD', '10-Q', dayAgo(26), read(3))
    const lease = doc('AMD', '10-Q', dayAgo(113), read(2))
    await seed(
      [HAND_DOC, old, lease],
      [
        HAND,
        passage(old, {
          figures: usd(5e9),
          quote: 'Anthropic committed to purchase $5 billion of AMD Instinct GPUs through 2028.',
          first_seen_at: read(2.9),
        }),
        passage(lease, {
          counterparty: 'Google LLC',
          counterparty_lab: null,
          quote: 'Google LLC provides a backstop for our lease obligations at the site.',
          first_seen_at: read(1.9),
        }),
      ],
    )
    expect(await writeSupplierAlerts(db, NOW)).toEqual({ written: 0, findings: 0 })
  })

  it('writes one alert per fresh filing, and nothing on a re-run', async () => {
    const d = doc('AMD', '10-Q', dayAgo(2), read(1))
    await seed(
      [HAND_DOC, d],
      [
        HAND,
        passage(d, {
          figures: usd(4.5e9),
          quote: 'Anthropic committed to purchase $4.5 billion of AMD Instinct GPUs through 2028.',
          first_seen_at: read(0.5),
        }),
      ],
    )
    expect(await writeSupplierAlerts(db, NOW)).toEqual({ written: 1, findings: 1 })
    const [alert] = await db.select().from(schema.alerts)
    expect(alert).toMatchObject({ rule: SUPPLIER_RULE, severity: 'notable' })
    const [change] = await db.select().from(schema.changes)
    expect(change).toMatchObject({
      entity_type: 'supplier_passage',
      provider: 'anthropic',
      change_type: 'added',
    })
    expect(JSON.parse(change!.after_json!)).toMatchObject({ passages: 1, ticker: 'AMD' })
    expect((await writeSupplierAlerts(db, NOW)).written).toBe(0)
    expect((await writeSupplierAlerts(db, new Date(NOW.getTime() + DAY))).written).toBe(0)
  })

  it('alerts from the judge’s run that reads the filing', async () => {
    const d = doc('AMD', '10-Q', dayAgo(2), read(1))
    const quote = 'Anthropic committed to purchase $4.5 billion of AMD Instinct GPUs through 2028.'
    const raw = new Map([[d.raw_key!, `<html><body><p>${quote}</p></body></html>`]])
    const readRaw = async (key: string) => raw.get(key) ?? null
    await seed([HAND_DOC, { ...d, judged_at: null }], [HAND])
    const reading = {
      document_id: d.accession_no,
      passages: [
        {
          relation: 'customer' as const,
          counterparty: 'Anthropic',
          figures: [{ value: 4.5e9, unit: 'usd' as const, meaning: 'GPU purchase commitment' }],
          quote,
          alias: null,
        },
      ],
    }
    expect(await applySupplierReview(db, readRaw, [reading], NOW)).toMatchObject({
      accepted: 1,
      settled: 1,
      alerts: 1,
    })
    // The same reading again: the document is settled, so nothing is offered or written.
    expect(await applySupplierReview(db, readRaw, [reading], NOW)).toMatchObject({ alerts: 0 })
    expect(await db.select().from(schema.alerts)).toHaveLength(1)
  })

  it('finds a filing naming two labs under each, one alert, and nothing on a re-run', async () => {
    const d = doc('AMD', '10-Q', dayAgo(2), read(1))
    await seed(
      [HAND_DOC, d],
      [
        HAND,
        passage(d, {
          figures: usd(4.5e9),
          quote: 'Anthropic committed to purchase $4.5 billion of AMD Instinct GPUs through 2028.',
          first_seen_at: read(0.5),
        }),
        passage(d, {
          counterparty: 'xAI',
          counterparty_lab: 'xai',
          quote: 'We began shipping MI500 systems to xAI for its Memphis data center.',
          first_seen_at: read(0.5),
        }),
      ],
    )
    expect(await writeSupplierAlerts(db, NOW)).toEqual({ written: 1, findings: 1 })
    const [alert, ...others] = await db.select().from(schema.alerts)
    expect(others).toEqual([])
    const changes = await db.select().from(schema.changes)
    expect(changes.map((c) => c.provider).sort()).toEqual(['anthropic', 'xai'])
    expect(JSON.parse(alert!.change_ids).sort()).toEqual(changes.map((c) => c.id).sort())
    const cites = await db.select().from(schema.alertCites)
    expect(cites.map((c) => c.provider).sort()).toEqual(['anthropic', 'xai'])
    expect((await writeSupplierAlerts(db, NOW)).written).toBe(0)
    expect((await writeSupplierAlerts(db, new Date(NOW.getTime() + DAY))).written).toBe(0)
    expect(await db.select().from(schema.changes)).toHaveLength(2)
  })

  it('relabels a suffixed name without writing an alert', async () => {
    // HUT's row as production holds it: "Google LLC", stored before the match read the suffix,
    // from a filing older than the window. And a fresh filing that already alerted with one.
    const old = doc('AMD', '10-Q', dayAgo(113), read(2))
    const fresh = doc('AMD', '8-K', dayAgo(2), read(1))
    const google = (d: Doc, quote: string, first_seen_at: string) =>
      passage(d, {
        relation: 'guarantee',
        counterparty: 'Google LLC',
        counterparty_lab: null,
        quote,
        first_seen_at,
      })
    await seed(
      [HAND_DOC, old, fresh],
      [
        HAND,
        google(
          old,
          'Google LLC provides a backstop for our lease obligations at the site.',
          read(1.9),
        ),
        google(
          fresh,
          'Google LLC guarantees the lease payments of our second campus here.',
          read(0.5),
        ),
        passage(fresh, {
          quote: 'We announced a multi-year collaboration with Anthropic on data center GPUs.',
          first_seen_at: read(0.5),
        }),
      ],
    )
    expect((await writeSupplierAlerts(db, NOW)).written).toBe(1)
    expect(await relabelPassages(db)).toBe(2)
    expect(await relabelPassages(db)).toBe(0)
    const relabeled = (await db.select().from(schema.supplierPassages)).filter(
      (p) => p.relation === 'guarantee',
    )
    expect(
      relabeled.map((p) => [p.counterparty, p.counterparty_ticker, p.counterparty_lab]),
    ).toEqual([
      ['Google', 'GOOGL', 'google'],
      ['Google', 'GOOGL', 'google'],
    ])
    expect((await writeSupplierAlerts(db, NOW)).written).toBe(0)
    expect(await db.select().from(schema.alerts)).toHaveLength(1)
  })

  it('stores a suffixed name the judge sends under its counterparty, and alerts under it', async () => {
    const d = doc('AMD', '8-K', dayAgo(2), read(1))
    const quote =
      'Google LLC agreed to guarantee $1.2 billion of the lease payments for the campus.'
    const raw = new Map([[d.raw_key!, `<html><body><p>${quote}</p></body></html>`]])
    const readRaw = async (key: string) => raw.get(key) ?? null
    await seed([HAND_DOC, { ...d, judged_at: null }], [HAND])
    const reading = {
      document_id: d.accession_no,
      passages: [
        {
          relation: 'guarantee' as const,
          counterparty: 'Google LLC',
          figures: [{ value: 1.2e9, unit: 'usd' as const, meaning: 'lease payments guaranteed' }],
          quote,
          alias: null,
        },
      ],
    }
    expect(await applySupplierReview(db, readRaw, [reading], NOW)).toMatchObject({
      accepted: 1,
      alerts: 1,
    })
    const [row] = (await db.select().from(schema.supplierPassages)).filter(
      (p) => p.basis === 'judge',
    )
    expect(row).toMatchObject({
      counterparty: 'Google',
      counterparty_ticker: 'GOOGL',
      counterparty_lab: 'google',
    })
    expect(await db.select().from(schema.alerts)).toMatchObject([{ severity: 'notable' }])
    expect(await db.select().from(schema.changes)).toMatchObject([{ provider: 'google' }])
  })

  it('keeps its rows from the judge', () => {
    expect(JUDGE_EXCLUDED_ENTITY_TYPES).toContain('supplier_passage')
  })
})
