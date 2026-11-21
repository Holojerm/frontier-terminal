import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import curated from '../server/curated/suppliers.json'
import type { FetchOutcome, SourceFetcher } from '#layers/core/server/pipeline/fetch'
import { figureWritten, supplierExcerpts } from '../server/suppliers/excerpts'
import { contains } from '#layers/core/server/pipeline/document-text'
import { accessionOf } from '#layers/core/server/pipeline/contracts/keys'
import { periodOf, runSupplierReads, supplierDocuments } from '../server/suppliers/ingest'
import { applySupplierReadings, checkPassage, supplierReview } from '../server/suppliers/review'
import { currentPassages, seedHandPassages, suppliersStamp } from '../server/suppliers/store'
import { querySuppliers } from '../server/utils/terminal-suppliers'

// The suppliers reader end to end on a made-up filer history: the hand-read
// rows seed the table, a new 10-Q is read and offered to the judge, and what
// the judge sends back is checked against the stored document before the
// table moves. Then the pure checks on their own.

const db = drizzle(env.DB, { schema })
const HAND = (curated as { rows: { ticker: string }[] }).rows

const AMD_CIK = '0000002488'
const NEW_10Q = '0000002488-26-000200'
const NEW_10Q_URL = `https://www.sec.gov/Archives/edgar/data/2488/000000248826000200/amd-20260926.htm`
const submissionsUrl = `https://data.sec.gov/submissions/CIK${AMD_CIK}.json`

const SUBMISSIONS = JSON.stringify({
  cik: '2488',
  filings: {
    recent: {
      form: ['10-Q', '4', '10-Q'],
      accessionNumber: [NEW_10Q, '0000002488-26-000199', '0000002488-26-000123'],
      filingDate: ['2026-11-04', '2026-11-03', '2026-08-05'],
      reportDate: ['2026-09-26', '', '2026-06-27'],
      primaryDocument: ['amd-20260926.htm', 'form4.xml', 'amd-20260627.htm'],
    },
  },
})

/** AMD's next 10-Q: the OpenAI passage restated with a new figure, and a new Anthropic tie. */
const NEW_10Q_HTML = `<html><body>
<p>Risk factors. We compete with Nvidia and others in data center GPUs.</p>
<p>In October 2025 and February 2026, we entered into multi-year agreements with OpenAI OpCo, LLC (OpenAI) and Meta Platforms, Inc. (Meta), respectively, under which each customer intends to deploy up to 7 gigawatts of AMD data center GPUs.</p>
<p>In September 2026, we entered into an agreement with Anthropic PBC under which Anthropic committed to purchase $4.5 billion of AMD Instinct GPUs through 2028.</p>
</body></html>`

const raw = new Map<string, string>()
const rawStore = { put: async (key: string, body: string) => void raw.set(key, body) }
const readRaw = async (key: string) => raw.get(key) ?? null

const fetcher: SourceFetcher = async (source) => {
  const ok = (text: string): FetchOutcome => ({ ok: true, status: 200, text, bytes: text.length })
  if (source.url === submissionsUrl) return ok(SUBMISSIONS)
  if (source.url === NEW_10Q_URL) return ok(NEW_10Q_HTML)
  return { ok: false, status: 404, detail: 'HTTP 404' }
}

const NOW = new Date('2026-11-20T12:00:00Z')

beforeEach(async () => {
  raw.clear()
  for (const table of [schema.supplierPassages, schema.supplierDocuments, schema.opsEvents]) {
    await db.delete(table)
  }
})

describe('the suppliers reader', () => {
  it('seeds the hand-read rows once', async () => {
    expect(await seedHandPassages(db)).toBe(HAND.length)
    expect(await seedHandPassages(db)).toBe(0)
    expect((await querySuppliers(db)).rows).toHaveLength(HAND.length)
  })

  it('reads a new 10-Q, offers it to the judge, and keeps only what the filing says', async () => {
    const before = await suppliersStamp(db)
    const report = await runSupplierReads(db, { raw: rawStore, fetcher, now: NOW })
    expect(report.read).toEqual([
      { ticker: 'AMD', accession_no: NEW_10Q, form: '10-Q', status: 'read', excerpts: 1 },
    ])
    // Read once: the next run fetches nothing new.
    const again = await runSupplierReads(db, { raw: rawStore, fetcher, now: NOW })
    expect(again.read).toEqual([])

    const [offered] = await supplierReview(db, readRaw)
    expect(offered).toMatchObject({ document_id: NEW_10Q, ticker: 'AMD', form: '10-Q' })
    expect(offered!.known.length).toBeGreaterThan(0)
    expect(offered!.excerpts.join(' ')).toContain('Anthropic PBC')

    const result = await applySupplierReadings(
      db,
      readRaw,
      [
        {
          document_id: NEW_10Q,
          passages: [
            {
              relation: 'customer',
              counterparty: 'Anthropic',
              figures: [
                { value: 4.5e9, unit: 'usd', meaning: 'GPU purchase commitment through 2028' },
              ],
              quote:
                'In September 2026, we entered into an agreement with Anthropic PBC under which Anthropic committed to purchase $4.5 billion of AMD Instinct GPUs through 2028.',
              alias: null,
            },
            // A figure the quote doesn't write is dropped.
            {
              relation: 'customer',
              counterparty: 'OpenAI',
              figures: [{ value: 8, unit: 'gw', meaning: 'GPUs OpenAI intends to deploy' }],
              quote:
                'agreements with OpenAI OpCo, LLC (OpenAI) and Meta Platforms, Inc. (Meta), respectively, under which each customer intends to deploy up to 7 gigawatts of AMD data center GPUs',
              alias: null,
            },
          ],
        },
      ],
      NOW,
    )
    expect(result).toMatchObject({ accepted: 1, settled: 1 })
    expect(result.rejected).toEqual([
      { reason: 'figure-not-in-quote', detail: '8 gw', document_id: NEW_10Q },
    ])

    const amd = await currentPassages(db, 'AMD')
    const anthropic = amd.find((r) => r.counterparty === 'Anthropic' && r.basis === 'judge')
    expect(anthropic).toMatchObject({
      counterparty_lab: 'anthropic',
      form: '10-Q',
      filed: '2026-11-04',
      period: 'quarter ended September 26, 2026',
      accession_no: NEW_10Q,
      source_url: NEW_10Q_URL,
    })
    // The hand-read 10-Q passages the new 10-Q no longer has have ended.
    const ended = (await db.select().from(schema.supplierPassages)).filter((r) => r.ended_at)
    expect(ended.length).toBeGreaterThan(0)
    expect(
      ended.every((r) => r.ticker === 'AMD' && r.form === '10-Q' && r.ended_by === NEW_10Q),
    ).toBe(true)
    // Settled: offered no more, and the cache key moved.
    expect(await supplierReview(db, readRaw)).toEqual([])
    expect(await suppliersStamp(db)).not.toBe(before)

    // A reading for a settled document is not taken.
    const late = await applySupplierReadings(
      db,
      readRaw,
      [{ document_id: NEW_10Q, passages: [] }],
      NOW,
    )
    expect(late.rejected.map((r) => r.reason)).toEqual(['not-offered'])
  })
})

describe('the checks', () => {
  const text =
    'Customer A accounted for 23% of revenue. Microsoft (the Partner) bought $1,250 million of servers. The Partner holds warrants for 160 million shares.'

  it('finds a figure only where the quote writes it, in its unit', () => {
    expect(
      figureWritten('commitment of $4.5 billion', { value: 4.5e9, unit: 'usd', meaning: '' }),
    ).toBe(true)
    expect(
      figureWritten('$1,250 million of servers', { value: 1.25e9, unit: 'usd', meaning: '' }),
    ).toBe(true)
    expect(
      figureWritten('accounted for 23% of revenue', {
        value: 23,
        unit: 'pct_revenue',
        meaning: '',
      }),
    ).toBe(true)
    expect(
      figureWritten('23 percent of revenue', { value: 23, unit: 'pct_revenue', meaning: '' }),
    ).toBe(true)
    expect(figureWritten('23 customers', { value: 23, unit: 'pct_revenue', meaning: '' })).toBe(
      false,
    )
    expect(figureWritten('up to 6 gigawatts', { value: 6, unit: 'gw', meaning: '' })).toBe(true)
    expect(figureWritten('160 million shares', { value: 160e6, unit: 'shares', meaning: '' })).toBe(
      true,
    )
    expect(figureWritten('160,000,000 shares', { value: 160e6, unit: 'shares', meaning: '' })).toBe(
      true,
    )
  })

  it('holds a passage to the document', () => {
    const base = { relation: 'customer' as const, figures: [], alias: null }
    expect(
      checkPassage(
        {
          ...base,
          counterparty: 'Microsoft',
          quote: 'Microsoft (the Partner) bought $1,250 million of servers.',
        },
        text,
      ),
    ).toBeNull()
    expect(
      checkPassage(
        {
          ...base,
          counterparty: 'Microsoft',
          quote: 'Microsoft bought $2 billion of servers from us.',
        },
        text,
      )?.reason,
    ).toBe('quote-not-in-document')
    expect(
      checkPassage(
        {
          ...base,
          counterparty: 'Oracle',
          quote: 'Microsoft (the Partner) bought $1,250 million of servers.',
        },
        text,
      )?.reason,
    ).toBe('counterparty-not-in-quote')
    expect(
      checkPassage(
        {
          ...base,
          relation: 'investor',
          counterparty: 'Microsoft',
          quote: 'The Partner holds warrants for 160 million shares.',
          alias: {
            term: 'the Partner',
            quote: 'Microsoft (the Partner) bought $1,250 million of servers.',
          },
        },
        text,
      ),
    ).toBeNull()
    expect(
      checkPassage(
        {
          ...base,
          relation: 'concentration',
          counterparty: 'Microsoft',
          quote: 'Microsoft (the Partner) bought $1,250 million of servers.',
        },
        text,
      )?.reason,
    ).toBe('concentration-names-a-company')
  })

  it('shows the judge the runs around a counterparty or a customer share, never the filer’s own name', () => {
    const doc = `${'filler '.repeat(400)}We buy GPUs from NVIDIA. ${'filler '.repeat(400)}Customer B accounted for 12% of revenue. ${'filler '.repeat(400)}`
    const forNvidia = supplierExcerpts(doc, 'NVDA')
    expect(forNvidia).toHaveLength(1)
    expect(forNvidia[0]).toContain('Customer B')
    const forRenter = supplierExcerpts(doc, 'CRWV')
    expect(forRenter).toHaveLength(2)
    expect(forRenter.every((e) => doc.includes(e))).toBe(true)
    expect(contains(doc, forRenter[0]!)).toBe(true)
  })

  it('lists the forms a filer is read for, after the last one read', () => {
    const docs = supplierDocuments(
      SUBMISSIONS,
      { cik: AMD_CIK, forms: ['10-Q', '10-K', '8-K'] },
      '2026-08-05',
    )
    expect(docs.map((d) => d.accession_no)).toEqual([NEW_10Q])
    expect(docs[0]!.url).toBe(NEW_10Q_URL)
    expect(periodOf('10-Q', '2026-09-26')).toBe('quarter ended September 26, 2026')
    expect(periodOf('8-K', '2026-09-26')).toBeNull()
    expect(accessionOf(NEW_10Q_URL)).toBe(NEW_10Q)
  })
})
