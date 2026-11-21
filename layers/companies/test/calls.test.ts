import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  actualFor,
  parseCompanyConcept,
  revenueOf,
  score,
  unscorable,
  type ConceptFact,
} from '../server/calls/actuals'
import {
  BACKFILL_SPEND_CAP_USD,
  costOf,
  keytermsFor,
  spendBasis,
  mp3Kbps,
  parseSentences,
  refusalOf,
  speakerMapping,
  MONTHLY_SPEND_CAP_USD,
  transcriptRequest,
} from '../server/calls/assemblyai'
import { CALL_TICKERS, callCompany, curatedCalls } from '../server/calls/curated'
import {
  BACKFILL_SINCE,
  earningsExhibits,
  earningsFilings,
  olderPages,
  pageFilings,
} from '../server/calls/edgar'
import { extractStatements, firstAmount, quoteOf, QUOTE_MAX_WORDS } from '../server/calls/extract'
import {
  assemblySpend,
  discoverExhibits,
  KIND_ASSEMBLYAI_CREDITS,
  LISTED_ROWS_PER_STATEMENT,
  listFilings,
  readConcepts,
  readFilingIndexes,
  readTextDocuments,
  resolveStatements,
  runAudio,
  settleDocument,
  syncCurated,
  type CallDeps,
  upsertListed,
} from '../server/calls/ingest'
import { fiscalPeriod, nextQuarter, periodLabel, reportedQuarter } from '../server/calls/periods'
import { applyGuidanceReadings, checkStatement, guidanceReview } from '../server/calls/review'
import {
  docxSentences,
  htmlSentences,
  repairWords,
  sentencesOf,
  spokenSentences,
} from '../server/calls/text'
import { decoded, pdfPages } from '#layers/core/server/pipeline/pdf-text'
import { fixtureText } from '#layers/core/test/pipeline/fixtures'

// The earnings-call reader on committed bytes: EDGAR's submissions feed, an
// 8-K index and release outlook, a company-concept document, excerpts of
// posted transcripts, and a trimmed AssemblyAI transcript; then the reader end
// to end against fake fetchers.

const SUBMISSIONS = fixtureText('fixtures/calls/amd-submissions.json')
const INDEX = fixtureText('fixtures/calls/amd-8k-index.htm')
const OUTLOOK = fixtureText('fixtures/calls/amd-q3-2026-release-outlook.htm')
const CONCEPT = fixtureText('fixtures/calls/amd-revenue-companyconcept.json')
const QCOM_FEED = fixtureText('fixtures/calls/qcom-submissions.json')
const QCOM_PAGE = fixtureText('fixtures/calls/qcom-submissions-001.json')
const QCOM_PAGE_URL = 'https://data.sec.gov/submissions/CIK0000804328-submissions-001.json'
const TSM_INDEX = fixtureText('fixtures/calls/tsm-6k-index-2021.htm')
const OLD = JSON.parse(fixtureText('fixtures/calls/exhibit-excerpts-2018-2022.json')) as {
  calls: {
    ticker: string
    call_date: string
    fy_end_month: number
    sentences: { text: string; page: number | null; at_ms: null; speaker: null }[]
  }[]
}
const DOCX = Uint8Array.from(
  atob(fixtureText('fixtures/calls/msft-fy19-q3-transcript.docx.b64').replace(/\s+/g, '')),
  (c) => c.charCodeAt(0),
)
const SENTENCES = fixtureText('fixtures/calls/assemblyai-amzn-q3-2026-sentences.json')
const JOB = fixtureText('fixtures/calls/assemblyai-amzn-q3-2026-job.json')
const EXCERPTS = JSON.parse(fixtureText('fixtures/calls/transcript-excerpts.json')) as {
  calls: {
    ticker: string
    call_date: string
    fy_end_month: number
    sentences: { text: string; page: number | null; at_ms: null; speaker: null }[]
  }[]
}

const AMD_CIK = '0000002488'
const AMD_ACCESSION = '0000002488-26-000188'
const AMD_INDEX = `https://www.sec.gov/Archives/edgar/data/2488/000000248826000188/${AMD_ACCESSION}-index.html`
const AMD_EXHIBIT = 'https://www.sec.gov/Archives/edgar/data/2488/000000248826000188/q32026991.htm'
const AMD_CONCEPT =
  'https://data.sec.gov/api/xbrl/companyconcept/CIK0000002488/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax.json'

const statementsOf = (ticker: string) => {
  const c = EXCERPTS.calls.find((x) => x.ticker === ticker)!
  return extractStatements(c.sentences, {
    fyEndMonth: c.fy_end_month,
    reported: reportedQuarter(c.fy_end_month, c.call_date),
  })
}

describe('fiscal calendars', () => {
  it('names a quarter by the fiscal year it ends in', () => {
    expect(periodLabel(1, reportedQuarter(1, '2026-11-17'))).toBe('Q3 FY2027')
    expect(periodLabel(10, reportedQuarter(10, '2026-09-02'))).toBe('Q3 FY2026')
    expect(periodLabel(5, reportedQuarter(5, '2026-01-07'))).toBe('Q2 FY2026')
    expect(periodLabel(12, reportedQuarter(12, '2026-02-03'))).toBe('Q4 2025')
    expect(fiscalPeriod(1, 2027, 3)).toMatchObject({ start: '2026-08-01', end: '2026-10-31' })
    expect(fiscalPeriod(6, 2027, null)).toMatchObject({ start: '2026-07-01', end: '2027-06-30' })
    expect(nextQuarter(12, fiscalPeriod(12, 2026, 4))).toMatchObject({
      fiscal_year: 2027,
      quarter: 1,
    })
  })
})

describe('text repair', () => {
  it('reads a Word transcript, paragraph by paragraph', async () => {
    const s = await docxSentences(DOCX)
    expect(s[0]!.text).toBe('Now let’s move to next quarter’s outlook.')
    // A full-year capex outlook restated in passing doesn't take the quarter's segment guides.
    const out = extractStatements(s, { fyEndMonth: 6, reported: reportedQuarter(6, '2019-04-24') })
    expect(out.map((x) => [x.segment, periodLabel(6, x.period)])).toContainEqual([
      'Intelligent Cloud',
      'Q4 FY2019',
    ])
    expect(out.every((x) => x.period.quarter === 4)).toBe(true)
  })

  it('joins the words a PDF split and closes up letter-spaced runs', () => {
    const doc =
      'We expect revenue. We said it. We know. W e expect revenue of $9 billio n, plus or m inus 2%.'
    expect(repairWords(doc)).toContain('We expect revenue of $9 billion, plus or minus 2%.')
    expect(repairWords("the year - over - year rate, FY ' 26")).toBe(
      "the year-over-year rate, FY '26",
    )
  })

  it('cuts sentences at a full stop, never inside a number or after U.S', () => {
    expect(sentencesOf('Revenue was $9.8 billion. In the U.S. it grew. Next.')).toEqual([
      'Revenue was $9.8 billion.',
      'In the U.S. it grew.',
      'Next.',
    ])
  })

  it('keeps what a Flate stream decoded when it ends without its checksum', async () => {
    const text = 'BT (We expect revenue) Tj ET '.repeat(40)
    const full = new Uint8Array(
      await new Response(
        new Blob([text]).stream().pipeThrough(new CompressionStream('deflate')),
      ).arrayBuffer(),
    )
    const cut = full.subarray(0, full.length - 4)
    const out = await decoded({ head: '<< /Filter /FlateDecode >>', stream: cut })
    expect(new TextDecoder().decode(out)).toBe(text)
  })
})

describe('PDF text', () => {
  it('reads the text a page draws through a form XObject', async () => {
    const pdf = [
      '%PDF-1.6',
      '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj',
      '2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj',
      '3 0 obj <</Type /Page /Parent 2 0 R /Contents 4 0 R /Resources <</XObject <</Fm0 5 0 R>> /Font <</F1 6 0 R>>>>>> endobj',
      '4 0 obj <</Length 12>> stream\nq /Fm0 Do Q\nendstream endobj',
      '5 0 obj <</Type /XObject /Subtype /Form /Length 39>> stream\nBT /F1 12 Tf (We expect revenue.) Tj ET\nendstream endobj',
      '6 0 obj <</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>> endobj',
      'trailer <</Root 1 0 R>>',
      '%%EOF',
    ].join('\n')
    const pages = await pdfPages(new TextEncoder().encode(pdf))
    expect(pages[0]).toContain('We expect revenue.')
  })
})

describe('extractStatements', () => {
  it('reads a range, a band and a capex year from a transcript', () => {
    const meta = statementsOf('META')
    expect(meta).toContainEqual(
      expect.objectContaining({
        metric: 'revenue',
        unit: 'USD',
        low: 73e9,
        high: 76e9,
        bound: 'range',
      }),
    )
    expect(meta.find((s) => s.metric === 'capex')).toMatchObject({
      low: 135e9,
      high: 145e9,
      period: { fiscal_year: 2026, quarter: null },
    })
    const nvda = statementsOf('NVDA')
    const rev = nvda.find((s) => s.metric === 'revenue')!
    expect(rev.low).toBeCloseTo(105.84e9, -6)
    expect(rev.high).toBeCloseTo(110.16e9, -6)
    expect(periodLabel(1, rev.period)).toBe('Q3 FY2027')
    expect(nvda.find((s) => s.metric === 'gross_margin')).toMatchObject({
      unit: 'percent',
      low: 73.5,
      high: 74.5,
      basis: 'gaap',
    })
  })

  it('names a segment and keeps total revenue apart from it', () => {
    const qcom = statementsOf('QCOM')
    expect(qcom).toContainEqual(
      expect.objectContaining({ metric: 'revenue', segment: null, low: 10.4e9, high: 11.2e9 }),
    )
    expect(qcom).toContainEqual(
      expect.objectContaining({ metric: 'segment_revenue', segment: 'QCT', low: 9e9, high: 9.6e9 }),
    )
    const msft = statementsOf('MSFT')
    expect(msft).toContainEqual(
      expect.objectContaining({ metric: 'revenue', low: 80.65e9, high: 81.75e9 }),
    )
    expect(msft).toContainEqual(
      expect.objectContaining({ segment: 'More Personal Computing', low: 12.3e9, high: 12.8e9 }),
    )
    expect(msft.every((s) => periodLabel(6, s.period) === 'Q3 FY2026')).toBe(true)
  })

  it('takes the guide, not the raise, and the midpoint figure', () => {
    const dell = statementsOf('DELL')
    expect(dell).toContainEqual(
      expect.objectContaining({ metric: 'revenue', low: 192e9, high: 192e9, bound: 'about' }),
    )
    expect(dell).toContainEqual(expect.objectContaining({ metric: 'ai_revenue', low: 74e9 }))
  })

  it('reads a letter-spaced S&P transcript and a capex range with no period of its own', () => {
    const cien = statementsOf('CIEN')
    expect(cien).toContainEqual(
      expect.objectContaining({ metric: 'revenue', low: 1.7e9, high: 1.8e9 }),
    )
    const crwv = statementsOf('CRWV')
    expect(crwv).toContainEqual(
      expect.objectContaining({
        metric: 'capex',
        low: 37e9,
        high: 39e9,
        period: expect.objectContaining({ quarter: null }),
      }),
    )
  })

  it('drops a figure for the quarter just reported, and a question', () => {
    const reported = reportedQuarter(12, '2026-11-03')
    const out = extractStatements(
      [
        {
          text: 'Revenue was $9.2 billion in the third quarter, above our guidance.',
          page: 1,
          at_ms: null,
          speaker: null,
        },
        {
          text: 'Do you expect revenue of $20 billion next quarter?',
          page: 1,
          at_ms: null,
          speaker: null,
        },
        {
          text: 'We expect fourth quarter revenue of $17 billion to $18 billion.',
          page: 2,
          at_ms: null,
          speaker: null,
        },
      ],
      { fyEndMonth: 12, reported },
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ low: 17e9, high: 18e9, page: 2 })
  })

  it('quotes at most QUOTE_MAX_WORDS words around the figure', () => {
    const long = `${'word '.repeat(40)}we expect revenue of $5 billion ${'more '.repeat(20)}`.trim()
    const q = quoteOf(long, long.indexOf('revenue'))
    expect(q.replace(/…/g, '').split(/\s+/).length).toBeLessThanOrEqual(QUOTE_MAX_WORDS)
    expect(q).toContain('revenue of $5 billion')
    expect(firstAmount('of $73 - 76 billion')).toMatchObject({ low: 73e9, high: 76e9 })
  })

  it('reads a range whose dash is a non-breaking hyphen or a minus sign', () => {
    for (const dash of ['\u2010', '\u2011', '\u2012', '\u2212']) {
      expect(firstAmount(`range to $195${dash}205 billion`)).toMatchObject({
        low: 195e9,
        high: 205e9,
      })
    }
  })
})

describe('EDGAR earnings filings', () => {
  it('lists the earnings 8-K and its EX-99 exhibits', () => {
    const filings = earningsFilings(SUBMISSIONS, AMD_CIK, '2025-10-01')
    expect(filings.map((f) => f.accession_no)).toEqual([AMD_ACCESSION])
    const exhibits = earningsExhibits(INDEX, AMD_CIK, AMD_ACCESSION, '8-K')
    expect(exhibits.map((e) => e.url)).toContain(AMD_EXHIBIT)
    expect(() => earningsExhibits(INDEX, AMD_CIK, '0000002488-26-000001', '8-K')).toThrow()
  })

  it('reads the outlook from the release', () => {
    const out = extractStatements(htmlSentences(OUTLOOK), {
      fyEndMonth: 12,
      reported: reportedQuarter(12, '2026-11-03'),
    })
    expect(out).toContainEqual(
      expect.objectContaining({ metric: 'revenue', low: 16.49e9, high: 17.51e9 }),
    )
    expect(out.find((s) => s.metric === 'gross_margin')).toMatchObject({
      basis: 'non_gaap',
      low: 55,
    })
  })
})

describe('actuals', () => {
  const facts: ConceptFact[] = parseCompanyConcept(CONCEPT, AMD_CIK).map((f) => ({
    ...f,
    source_url: AMD_CONCEPT,
    fetched_at: '2026-11-21T00:00:00Z',
  }))

  it('derives a fourth quarter from the year less the nine months, public at the 10-K', () => {
    const q4 = revenueOf(facts, 12, fiscalPeriod(12, 2025, 4))!
    expect(q4.value).toBe(34_639e6 - 24_369e6)
    expect(q4.filed).toBe('2026-02-04')
    expect(revenueOf(facts, 12, fiscalPeriod(12, 2026, 3))!.value).toBe(13_377e6)
  })

  it('scores a growth guide against the same quarter a year before', () => {
    const g = actualFor(
      'AMD',
      { metric: 'revenue', unit: 'growth_yoy' },
      fiscalPeriod(12, 2026, 3),
      12,
      facts,
    )!
    expect(g.value).toBeCloseTo((13_377 / 9_246 - 1) * 100, 6)
  })

  it('scores a range, a single figure and a bound', () => {
    expect(score({ low: 9.3e9, high: 9.9e9, bound: 'range', unit: 'USD' }, 10.27e9)).toMatchObject({
      state: 'above',
    })
    expect(score({ low: 22e9, high: 22e9, bound: 'about', unit: 'USD' }, 22.2e9)).toMatchObject({
      state: 'met',
    })
    expect(
      score({ low: 12.3e9, high: 12.3e9, bound: 'at_least', unit: 'USD' }, 10.2e9),
    ).toMatchObject({ state: 'below' })
    // A figure three times the guide is some other measure.
    expect(score({ low: 0.65e9, high: 0.65e9, bound: 'at_least', unit: 'USD' }, 10e9)).toBeNull()
  })

  it('leaves segments, non-GAAP margins, Amazon capex and foreign filers unscored', () => {
    const base = { unit: 'USD', basis: null, segment: null }
    expect(unscorable('QCOM', { ...base, metric: 'segment_revenue', segment: 'QCT' })).toMatch(
      /segment/,
    )
    expect(
      unscorable('AMD', { ...base, metric: 'gross_margin', unit: 'percent', basis: 'non_gaap' }),
    ).toMatch(/non-GAAP/)
    expect(unscorable('AMZN', { ...base, metric: 'capex' })).toMatch(/net capex/)
    expect(unscorable('TSM', { ...base, metric: 'revenue' })).toMatch(/foreign/)
    expect(unscorable('AMD', { ...base, metric: 'revenue' })).toBeNull()
  })
})

describe('AssemblyAI', () => {
  it('asks for the flagship model with key terms, a prompt, speakers and spelling', () => {
    const body = transcriptRequest('https://example.com/a.mp3', callCompany('AMZN')) as Record<
      string,
      any
    >
    expect(body.speech_models).toEqual(['assemblyai-stt-3-7'])
    expect(body.speaker_labels).toBe(true)
    expect(body.speaker_options).toEqual({ min_speakers_expected: 5, max_speakers_expected: 17 })
    expect(body.keyterms_prompt).toEqual(
      expect.arrayContaining(['Andy Jassy', 'Trainium', 'Anthropic', 'Claude']),
    )
    expect(
      body.speech_understanding.request.speaker_identification.speakers.map(
        (s: { name: string }) => s.name,
      ),
    ).toContain('Analyst')
    expect(body.disfluencies).toBe(false)
    const terms = keytermsFor(callCompany('AMZN'))
    expect(terms.every((t) => t.split(/\s+/).length <= 6)).toBe(true)
    expect(new Set(terms.map((t) => t.toLowerCase())).size).toBe(terms.length)
  })

  it('reads an MP3 bitrate from the first frame and costs an hour at the rates requested', () => {
    expect(mp3Kbps(new Uint8Array([0, 0xff, 0xfb, 0xb0, 0x00]))).toBe(192)
    expect(
      mp3Kbps(new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 2, 9, 9, 0xff, 0xfb, 0x50, 0])),
    ).toBe(64)
    expect(costOf(3600)).toBeCloseTo(0.35, 6)
    expect(refusalOf(401, '{"error":"Your account has insufficient credits"}')).toBe('credits')
    expect(refusalOf(401, '{"error":"Invalid API key"}')).toBe('auth')
    expect(refusalOf(500, 'oops')).toBe('other')
  })

  it('names the speakers and keeps only what the executives said', () => {
    const job = JSON.parse(JOB) as unknown
    expect(speakerMapping(job)).toMatchObject({ C: 'Andy Jassy', D: 'Brian Olsavsky' })
    const spoken = spokenSentences(parseSentences(SENTENCES, speakerMapping(job)))
    const c = callCompany('AMZN')
    const out = extractStatements(spoken, {
      fyEndMonth: 12,
      reported: reportedQuarter(12, '2026-10-29'),
      speakers: c.speakers!.map((s) => s.name),
    })
    expect(out.map((s) => [s.metric, s.low, s.high, s.speaker, s.at_ms])).toEqual([
      ['capex', 220e9, 220e9, 'Andy Jassy', 626910],
      ['revenue', 240e9, 247e9, 'Brian Olsavsky', 1458670],
    ])
  })
})

describe('EDGAR back to 2018', () => {
  it('names the paged files that reach back to 2018, and reads their earnings 8-Ks', () => {
    expect(olderPages(QCOM_FEED, '0000804328', BACKFILL_SINCE)).toEqual([QCOM_PAGE_URL])
    const old = pageFilings(QCOM_PAGE, '0000804328', BACKFILL_SINCE)
    // Item 2.02 only, and nothing filed before 2018.
    expect(old.map((f) => f.filed)).toEqual(['2018-01-31', '2018-04-25', '2018-07-25'])
    expect(old[0]!.index_url).toMatch(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/804328\//)
    expect(() => pageFilings('{"form":[]}', '0000804328', BACKFILL_SINCE)).toThrow()
  })

  it('keeps a 6-K exhibit whose description only repeats its type, and skips a subsidiary’s', () => {
    const acc = '0001564590-21-018896'
    const ex = earningsExhibits(TSM_INDEX, '0001046179', acc, '6-K')
    expect(ex.map((e) => e.type)).toEqual(['EX-99.1', 'EX-99.2'])
    expect(earningsExhibits(TSM_INDEX, '0001046179', acc, '6-K', /ex991/)).toHaveLength(1)
  })
})

describe('2018-2022 releases', () => {
  const read = (ticker: string) => {
    const c = OLD.calls.find((x) => x.ticker === ticker)!
    return extractStatements(c.sentences, {
      fyEndMonth: c.fy_end_month,
      reported: reportedQuarter(c.fy_end_month, c.call_date),
    }).map((s) => ({ ...s, label: periodLabel(c.fy_end_month, s.period) }))
  }

  it('reads a spelled-out band, and GAAP and non-GAAP margins given "respectively"', () => {
    const nvda = read('NVDA')
    expect(nvda[0]).toMatchObject({ metric: 'revenue', label: 'Q2 FY2019', bound: 'range' })
    expect(nvda[0]!.low).toBeCloseTo(3.038e9, -5)
    const margins = nvda.filter((s) => s.metric === 'gross_margin')
    expect(margins.map((s) => [s.basis, s.low, s.high])).toEqual([
      ['gaap', 62.8, 63.8],
      ['non_gaap', 63, 64],
    ])
    expect(read('MRVL')[0]).toMatchObject({ low: 1_033_050_000, high: 1_096_950_000 })
  })

  it('takes the guided quarter, not the one compared against or a date’s year', () => {
    expect(read('AMZN')).toEqual([
      expect.objectContaining({ metric: 'revenue', low: 51e9, high: 54e9, label: 'Q2 2018' }),
    ])
    expect(read('CLS')[0]).toMatchObject({ low: 1.575e9, label: 'Q2 2018' })
  })

  it('reads an outlook list and an outlook table under their lead-in', () => {
    expect(read('AAOI').map((s) => [s.metric, s.low, s.high, s.label])).toEqual([
      ['revenue', 75e6, 81e6, 'Q2 2018'],
      ['gross_margin', 39.5, 41, 'Q2 2018'],
    ])
    expect(read('QCOM')).toEqual([
      expect.objectContaining({ metric: 'revenue', low: 4.8e9, high: 5.6e9, label: 'Q3 FY2018' }),
    ])
    expect(read('BE').map((s) => [s.metric, s.low, s.high, s.label])).toEqual([
      ['revenue', 950e6, 1e9, '2021'],
      ['gross_margin', 25, 25, '2021'],
    ])
  })

  it('gives each figure its own basis', () => {
    expect(read('INTC').map((s) => [s.basis, s.low])).toEqual([
      ['gaap', 77e9],
      ['non_gaap', 72.5e9],
    ])
    expect(
      unscorable('INTC', { metric: 'revenue', unit: 'USD', basis: 'non_gaap', segment: null }),
    ).toMatch(/non-GAAP/)
  })

  it('takes no multi-year target, part of capex, backlog now, kilowatt-hours or slide columns', () => {
    for (const t of ['HPE', 'WMB', 'COHR', 'PNW', 'AMD']) expect(read(t), t).toEqual([])
  })
})

describe('the curated list', () => {
  it('covers the 45 companies, each with a reason where it posts nothing we read', () => {
    expect(CALL_TICKERS).toHaveLength(45)
    for (const c of curatedCalls.companies) {
      if (c.posts !== 'transcript') expect(c.gap, c.ticker).not.toBeNull()
    }
    for (const d of curatedCalls.documents) expect(CALL_TICKERS, d.url).toContain(d.ticker)
    for (const d of curatedCalls.documents.filter((x) => x.kind === 'audio'))
      expect(callCompany(d.ticker).speakers, d.ticker).toBeDefined()
  })
})

// ─── the reader against fake fetchers ───────────────────────────────────────

const store = new Map<string, string>()
const ok = (text: string): FetchOutcome => ({ ok: true, status: 200, text, bytes: text.length })
const fetcherOf =
  (pages: Record<string, string>): SourceFetcher =>
  async (s) =>
    pages[s.url] === undefined ? { ok: false, status: 404, detail: 'HTTP 404' } : ok(pages[s.url]!)

function depsWith(over: Partial<CallDeps> = {}): CallDeps {
  return {
    raw: { put: async (k, b) => void store.set(k, b) },
    readRaw: async (k) => store.get(k) ?? null,
    fetcher: fetcherOf({
      'https://data.sec.gov/submissions/CIK0000002488.json': SUBMISSIONS,
      [AMD_INDEX]: INDEX,
      [AMD_EXHIBIT]: OUTLOOK,
      [AMD_CONCEPT]: CONCEPT,
    }),
    fetch: async () => new Response('not found', { status: 404 }),
    userAgent: () => 'test',
    assemblyKey: '',
    now: new Date('2026-11-21T09:00:00Z'),
    ...over,
  }
}

const docRow = (over: Partial<typeof schema.callDocuments.$inferInsert>) => ({
  id: `doc-${Math.random().toString(36).slice(2)}`,
  ticker: 'AMD',
  call_date: '2025-11-04',
  period_label: 'Q3 2025',
  fiscal_year: 2025,
  fiscal_quarter: 3,
  kind: 'exhibit',
  url: 'https://example.com/doc',
  status: 'pending',
  first_seen_at: '2026-11-21T00:00:00Z',
  source_url: 'https://example.com/doc',
  fetched_at: '2026-11-21T00:00:00Z',
  ...over,
})

beforeEach(async () => {
  store.clear()
  for (const t of [
    schema.callDocuments,
    schema.filedGuidance,
    schema.guidanceResolutions,
    schema.filedFacts,
    schema.filedFactReads,
    schema.opsEvents,
  ]) {
    await db.delete(t)
  }
})

describe('the reader', () => {
  it('lists the curated documents once, a backfilled replay as submitted', async () => {
    const now = new Date('2026-11-21T09:00:00Z')
    expect(await syncCurated(db, now)).toBe(curatedCalls.documents.length)
    expect(await syncCurated(db, now)).toBe(0)
    const audio = await db
      .select()
      .from(schema.callDocuments)
      .where(eq(schema.callDocuments.kind, 'audio'))
    // Every backfill replay was sent from the mini; a newer one waits for the Worker, on the month's cap.
    for (const a of audio) {
      expect(a.status, a.url).toBe(a.job_id ? 'submitted' : 'pending')
      if (spendBasis(a.call_date) === 'backfill') expect(a.job_id, a.url).toBeTruthy()
    }
  })

  it('finds the earnings exhibits, reads them, and stores the outlook', async () => {
    // Every other ticker read just now, so AMD's feed is the stalest.
    for (const t of CALL_TICKERS.filter((x) => x !== 'AMD')) {
      await db.insert(schema.filedFactReads).values({
        id: `r-${t}`,
        ticker: t,
        kind: 'call-submissions',
        accession_no: null,
        status: 'ok',
        detail: null,
        content_hash: null,
        facts: 0,
        started_at: '2026-11-21T08:59:00Z',
        source_url: 'x',
      })
    }
    const deps = depsWith()
    const found = await discoverExhibits(db, deps)
    expect(found.filings).toBe(1)
    const read = await readTextDocuments(db, deps)
    expect(read.statements).toBeGreaterThanOrEqual(2)
    const rows = await db.select().from(schema.filedGuidance)
    expect(rows.find((r) => r.metric === 'revenue')).toMatchObject({
      source: 'exhibit',
      accession_no: AMD_ACCESSION,
      filed: '2026-11-03',
      fiscal_quarter: 4,
      period_end: '2026-12-31',
    })
    // A second run finds nothing new.
    expect((await discoverExhibits(db, deps)).filings).toBe(0)
  })

  it('scores a quarter once its year is filed, and serves it with the filing', async () => {
    const deps = depsWith()
    const [doc] = await db
      .insert(schema.callDocuments)
      .values(docRow({ url: 'https://example.com/amd-q3-2025' }))
      .returning()
    await settleDocument(db, deps, doc!, [
      {
        text: 'For the fourth quarter of 2025, AMD expects revenue to be approximately $9.6 billion, plus or minus $300 million.',
        page: null,
        at_ms: null,
        speaker: null,
      },
    ])
    const open = await db.select().from(schema.filedGuidance)
    expect(await readConcepts(db, deps, open)).toBeGreaterThan(0)
    expect(await resolveStatements(db, open, deps.now)).toBe(1)
    const [r] = await db.select().from(schema.guidanceResolutions)
    expect(r).toMatchObject({ state: 'above', actual: 10_270e6, filed: '2026-02-04' })
    expect(r!.error_share).toBeCloseTo(10.27 / 9.6 - 1, 6)
    const data = await queryCallGuidance(db, queryContext(fixtureText('sources.yaml'), null))
    expect(data.statements[0]).toMatchObject({ ticker: 'AMD', state: 'above', period: 'Q4 2025' })
    expect(data.statements[0]!.actual?.filing_url).toContain('000000248826000018')
    expect(data.tally).toMatchObject({ statements: 1, scored: 1, above: 1 })
  })

  it('collects a finished replay once, with its billed cost', async () => {
    await db.insert(schema.callDocuments).values(
      docRow({
        ticker: 'AMZN',
        call_date: '2026-10-29',
        kind: 'audio',
        status: 'submitted',
        job_id: '042832d4-e03a-40ca-af7e-20231166f304',
        url: 'https://example.com/amzn.mp3',
      }),
    )
    const fetch = async (url: string | URL | Request) =>
      String(url).endsWith('/sentences') ? new Response(SENTENCES) : new Response(JOB)
    const out = await runAudio(
      db,
      depsWith({ assemblyKey: 'k', fetch: fetch as typeof globalThis.fetch }),
    )
    expect(out).toMatchObject({ collected: 1, statements: 2 })
    const [doc] = await db.select().from(schema.callDocuments)
    expect(doc).toMatchObject({ status: 'read', statements: 2 })
    expect(doc!.cost_usd).toBeCloseTo(costOf(JSON.parse(JOB).audio_duration), 6)
    const rows = await db.select().from(schema.filedGuidance)
    expect(rows.find((r) => r.metric === 'revenue')).toMatchObject({
      source: 'audio',
      speaker: 'Brian Olsavsky',
      at_ms: 1458670,
    })
  })

  it('counts only the current UTC month against the spend cap', async () => {
    await db.insert(schema.callDocuments).values([
      docRow({
        ticker: 'AEP',
        kind: 'audio',
        status: 'read',
        cost_usd: 9,
        submitted_at: '2026-10-31T23:00:00Z',
        url: 'https://example.com/october.mp3',
      }),
      docRow({
        ticker: 'AEP',
        kind: 'audio',
        status: 'read',
        cost_usd: 3,
        submitted_at: '2026-11-02T10:00:00Z',
        url: 'https://example.com/november.mp3',
      }),
    ])
    expect(await assemblySpend(db, new Date('2026-11-21T09:00:00Z'))).toBe(3)
    expect(await assemblySpend(db, new Date('2026-12-01T00:00:00Z'))).toBe(0)
  })

  it('stops at the spend cap, and on exhausted credits, with an ops event each', async () => {
    await db.insert(schema.callDocuments).values([
      docRow({
        ticker: 'AEP',
        kind: 'audio',
        status: 'read',
        cost_usd: MONTHLY_SPEND_CAP_USD - 0.1,
        url: 'https://example.com/old.mp3',
      }),
      docRow({
        ticker: 'AEP',
        kind: 'audio',
        status: 'pending',
        url: 'https://example.com/new.mp3',
      }),
    ])
    const head = new Uint8Array(65536)
    head.set([0xff, 0xfb, 0xb0, 0x00])
    const ranged = async () =>
      new Response(head, { status: 206, headers: { 'content-range': 'bytes 0-65535/76030272' } })
    let posted = 0
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted++
        return new Response('{"error":"Your account has insufficient credits"}', { status: 401 })
      }
      return ranged()
    }
    await runAudio(db, depsWith({ assemblyKey: 'k', fetch: fetch as typeof globalThis.fetch }))
    expect(posted).toBe(0)
    let events = await db.select().from(schema.opsEvents)
    expect(events.map((e) => e.kind)).toEqual([KIND_ASSEMBLYAI_CREDITS])
    expect(events[0]!.detail).toMatch(/spend cap/)

    await db
      .update(schema.callDocuments)
      .set({ cost_usd: 1 })
      .where(eq(schema.callDocuments.status, 'read'))
    await db.delete(schema.opsEvents)
    await runAudio(db, depsWith({ assemblyKey: 'k', fetch: fetch as typeof globalThis.fetch }))
    expect(posted).toBe(1)
    events = await db.select().from(schema.opsEvents)
    expect(events.map((e) => e.kind)).toEqual([KIND_ASSEMBLYAI_CREDITS])
    const [pending] = await db
      .select()
      .from(schema.callDocuments)
      .where(eq(schema.callDocuments.url, 'https://example.com/new.mp3'))
    expect(pending!.status).toBe('pending')
  })

  it('lists a full chunk of filings within D1’s bound-parameter cap', () => {
    const row = (i: number) => ({
      id: `f-${i}`,
      ticker: 'QCOM',
      kind: 'call-filing',
      accession_no: `a-${i}`,
      status: 'listed',
      detail: '{}',
      content_hash: null,
      facts: 0,
      started_at: '2026-11-21T16:23:00Z',
      source_url: 'x',
    })
    const rows = Array.from({ length: LISTED_ROWS_PER_STATEMENT }, (_, i) => row(i))
    expect(upsertListed(db, rows).toSQL().params.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS)
  })

  it('lists the backfill from the paged files once, then reads index pages newest first', async () => {
    for (const t of CALL_TICKERS.filter((x) => x !== 'QCOM')) {
      await db.insert(schema.filedFactReads).values({
        id: `r-${t}`,
        ticker: t,
        kind: 'call-submissions',
        accession_no: null,
        status: 'ok',
        detail: null,
        content_hash: null,
        facts: 0,
        started_at: '2026-11-21T08:59:00Z',
        source_url: 'x',
      })
    }
    const asked: string[] = []
    const pages: Record<string, string> = {
      'https://data.sec.gov/submissions/CIK0000804328.json': QCOM_FEED,
      [QCOM_PAGE_URL]: QCOM_PAGE,
    }
    const fetcher: SourceFetcher = async (s) => {
      asked.push(s.url)
      return pages[s.url] === undefined
        ? { ok: false, status: 404, detail: 'HTTP 404' }
        : ok(pages[s.url]!)
    }
    const deps = depsWith({ fetcher, limits: { submissions: 1, indexPages: 1 } })
    expect(await listFilings(db, deps)).toBe(5)
    expect(asked).toEqual(['https://data.sec.gov/submissions/CIK0000804328.json', QCOM_PAGE_URL])
    asked.length = 0
    await readFilingIndexes(db, deps)
    // The newest listed filing first: the feed's own, before the backfill's.
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('0000804328-26-000127')
    // The page read cleanly once is never read again; nothing is listed twice, but the
    // filing whose index failed is listed again.
    asked.length = 0
    await db
      .delete(schema.filedFactReads)
      .where(
        and(
          eq(schema.filedFactReads.ticker, 'QCOM'),
          eq(schema.filedFactReads.kind, 'call-submissions'),
        ),
      )
    expect(await listFilings(db, { ...deps, now: new Date('2026-11-22T09:00:00Z') })).toBe(1)
    expect(asked).toEqual(['https://data.sec.gov/submissions/CIK0000804328.json'])
  })

  it('keeps the backfill’s spend apart from the month’s, and stops it at its ceiling', async () => {
    expect(spendBasis('2025-09-30')).toBe('backfill')
    expect(spendBasis('2025-10-01')).toBe('monthly')
    await db.insert(schema.callDocuments).values([
      docRow({
        ticker: 'AEP',
        kind: 'audio',
        status: 'read',
        call_date: '2019-10-24',
        cost_usd: BACKFILL_SPEND_CAP_USD - 0.1,
        submitted_at: '2026-11-21T08:00:00Z',
        url: 'https://example.com/2019.mp3',
      }),
      docRow({
        ticker: 'AEP',
        kind: 'audio',
        status: 'pending',
        call_date: '2019-07-25',
        url: 'https://example.com/2019-july.mp3',
      }),
      docRow({
        ticker: 'AEP',
        kind: 'audio',
        status: 'pending',
        call_date: '2026-10-28',
        url: 'https://example.com/new.mp3',
      }),
    ])
    const now = new Date('2026-11-21T09:00:00Z')
    expect(await assemblySpend(db, now, 'monthly')).toBe(0)
    expect(await assemblySpend(db, now, 'backfill')).toBeCloseTo(BACKFILL_SPEND_CAP_USD - 0.1, 6)
    const head = new Uint8Array(65536)
    head.set([0xff, 0xfb, 0xb0, 0x00])
    const posted: string[] = []
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)).audio_url)
        return new Response(`{"id":"00000000-0000-4000-8000-00000000000${posted.length}"}`)
      }
      return new Response(head, {
        status: 206,
        headers: { 'content-range': 'bytes 0-65535/76030272' },
      })
    }
    const out = await runAudio(
      db,
      depsWith({ assemblyKey: 'k', fetch: fetch as typeof globalThis.fetch }),
    )
    // The new call goes on the month's cap; the old one would pass the backfill's ceiling.
    expect(posted).toEqual(['https://example.com/new.mp3'])
    expect(out.backfill_spent_usd).toBeCloseTo(BACKFILL_SPEND_CAP_USD - 0.1, 6)
    const events = await db.select().from(schema.opsEvents)
    expect(events.map((e) => e.detail)).toEqual([expect.stringMatching(/backfill ceiling/)])
  })

  it('sends nothing to AssemblyAI without a key', async () => {
    let calls = 0
    const fetch = async () => {
      calls++
      return new Response('{}')
    }
    await runAudio(db, depsWith({ fetch: fetch as typeof globalThis.fetch }))
    expect(calls).toBe(0)
  })
})

describe('the judge’s guidance review', () => {
  const sentences = [
    { text: 'Thank you, operator.', page: 1, at_ms: null, speaker: null },
    {
      text: 'Our outlook for the next quarter anticipates revenue near $5.1 billion, give or take a little.',
      page: 3,
      at_ms: null,
      speaker: null,
    },
  ]

  it('offers a document the parser found nothing in, and gates what comes back', async () => {
    const raw_key = 'calls/amd/test.json'
    store.set(raw_key, JSON.stringify({ url: 'x', sentences }))
    await db.insert(schema.callDocuments).values(
      docRow({
        id: 'doc-judge',
        kind: 'transcript',
        status: 'read',
        statements: 0,
        raw_key,
        call_date: '2026-11-03',
      }),
    )
    const now = new Date('2026-11-21T09:00:00Z')
    const offered = await guidanceReview(db, async (k) => store.get(k) ?? null, now)
    expect(offered.map((o) => [o.document_id, o.excerpts.length, o.reported])).toEqual([
      ['doc-judge', 1, 'Q3 2025'],
    ])
    const quote = 'anticipates revenue near $5.1 billion, give or take a little.'
    const report = await applyGuidanceReadings(
      db,
      async (k) => store.get(k) ?? null,
      [
        {
          document_id: 'doc-judge',
          statements: [
            {
              metric: 'revenue',
              segment: null,
              unit: 'USD',
              bound: 'about',
              low: 5.1e9,
              high: 5.1e9,
              fiscal_year: 2026,
              fiscal_quarter: 4,
              quote,
            },
            {
              metric: 'revenue',
              segment: null,
              unit: 'USD',
              bound: 'about',
              low: 6e9,
              high: 6e9,
              fiscal_year: 2026,
              fiscal_quarter: 4,
              quote,
            },
            {
              metric: 'revenue',
              segment: null,
              unit: 'USD',
              bound: 'about',
              low: 5.1e9,
              high: 5.1e9,
              fiscal_year: 2026,
              fiscal_quarter: 4,
              quote: 'revenue of $5.1 billion next quarter',
            },
          ],
        },
      ],
      now,
    )
    expect(report.accepted).toBe(1)
    expect(report.rejected.map((r) => r.reason)).toEqual([
      'figure-not-in-quote',
      'quote-not-in-document',
    ])
    const [row] = await db.select().from(schema.filedGuidance)
    expect(row).toMatchObject({
      method: 'judge',
      source: 'transcript',
      page: 3,
      period_end: '2026-12-31',
    })
    expect(await guidanceReview(db, async (k) => store.get(k) ?? null, now)).toEqual([])
  })

  it('rejects a period that is not ahead of the reported quarter', () => {
    expect(
      checkStatement(
        {
          metric: 'capex',
          segment: null,
          unit: 'USD',
          bound: 'about',
          low: 2e10,
          high: 2e10,
          fiscal_year: 2025,
          fiscal_quarter: null,
          quote: 'capex of $20 billion',
        },
        'We expect capex of $20 billion this year.',
        12,
        '2026-09-30',
      ),
    ).toMatchObject({ reason: 'period-not-ahead' })
  })
})
