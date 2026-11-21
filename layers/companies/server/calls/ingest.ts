// One run of the call reader, hourly (tasks/calls/read.ts):
//
//   1. curated documents (curated/earnings-calls.json) not held yet become call_documents
//      rows; a replay submitted from the mini arrives as `submitted` with its job id;
//   2. EDGAR: a few tickers' submissions feeds a run (with the paged files back to
//      BACKFILL_SINCE) list each earnings 8-K (item 2.02) or 6-K not yet listed; then a
//      fixed number of listed filings' index pages, newest first, give their EX-99
//      exhibits. A new filing goes ahead of the backfill;
//   3. text documents not read yet, newest call first: fetched, cut into sentences, kept
//      in R2 (never served), and their guidance stored in filed_guidance;
//   4. AssemblyAI: each submitted job is checked once (no polling loop), a finished one is
//      read like a transcript, and new replays are submitted while their basis has room
//      (a call since BACKFILL_BEFORE under MONTHLY_SPEND_CAP_USD, an older one under
//      BACKFILL_SPEND_CAP_USD);
//   5. for each ticker with guidance whose period has ended, the XBRL concepts it is
//      scored on, at most once a day each; then each statement the facts now settle gets
//      its guidance_resolutions row.
//
// A failed step spools one ops event and the next step still runs. Running out of
// credits, or AssemblyAI refusing the key, spools its own event and stops submitting until
// a run finds credits again.

import { and, asc, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import {
  actualFor,
  conceptUrl,
  neededConcepts,
  parseCompanyConcept,
  score,
  unscorable,
  type ConceptFact,
} from './actuals'
import {
  ASSEMBLYAI_API,
  BACKFILL_BEFORE,
  BACKFILL_SPEND_CAP_USD,
  costOf,
  replaySeconds,
  parseSentences,
  speakerMapping,
  refusalOf,
  MONTHLY_SPEND_CAP_USD,
  spendBasis,
  transcriptRequest,
  type SpendBasis,
} from './assemblyai'
import { CALL_CONCEPT_NEEDS } from '#server/registries/call-concepts'
import { CALL_COMPANIES, callCompany, curatedCalls, type CallCompany } from './curated'
import {
  BACKFILL_SINCE,
  earningsExhibits,
  earningsFilings,
  olderPages,
  pageFilings,
  type EarningsFiling,
  type Exhibit,
} from './edgar'
import { extractStatements, type Statement } from './extract'
import { fiscalPeriod, periodLabel, reportedQuarter } from './periods'
import {
  docxSentences,
  htmlSentences,
  pdfSentences,
  spokenSentences,
  type DocSentence,
} from './text'

export const KIND_CALL_READ_FAILED = 'call_read_failed'
export const KIND_ASSEMBLYAI_CREDITS = 'assemblyai_credits'

/**
 * What one hourly run reads. SEC requests go through the pacer at 4 a second:
 * three feeds, their paged files, 40 index pages and up to 40 exhibits take
 * about 25 seconds. A document costs tens of milliseconds of CPU (a 300 KB
 * transcript PDF about 20). The 2018 backfill, about 2,100 filings and 2,600
 * documents, drains in about 60 runs, newest first, with any new call read first.
 */
export const CALL_LIMITS = {
  submissions: 3,
  indexPages: 40,
  textDocs: 40,
  audioSubmits: 3,
  conceptReads: 20,
}
export type CallLimits = typeof CALL_LIMITS
export const RETRY_AFTER_MS = 86_400_000
/** Facts kept from a company-concept document: a year before the backfill, so a 2018 growth guide has its base. */
export const FACTS_SINCE = '2017-01-01'
export const MAX_ATTEMPTS = 3
/** A text document over this is not a transcript (Hut 8 posts 12 MB ones). */
export const DOC_MAX_BYTES = 16 * 1024 * 1024
/** The call sources read here; `release` rows are the hyperscaler capex reader's. */
export const CALL_SOURCES = ['exhibit', 'transcript', 'remarks', 'audio'] as const

/** One XBRL concept of one filer that another layer needs the call reader to read. */
export interface ConceptNeed {
  ticker: string
  concept: string
  cik: string
}

/** What a layer adds to the reader's concept reads each run (server/registries/call-concepts.ts). */
export type ConceptNeeds = (db: PipelineDb, today: string) => Promise<ConceptNeed[]>

export interface CallDeps {
  raw: RawStore
  readRaw: RawReader
  /** EDGAR's JSON and HTML, through the SEC pacer. */
  fetcher: SourceFetcher
  /** PDFs, other hosts' pages and AssemblyAI. */
  fetch?: typeof globalThis.fetch
  userAgent: (url: string) => string | null
  /** NUXT_ASSEMBLYAI_API_KEY; empty = audio is neither submitted nor collected. */
  assemblyKey: string
  now: Date
  /** Overrides for one run (a local backfill run reads more). */
  limits?: Partial<CallLimits>
}

export interface CallReadReport {
  curated: number
  listed: number
  filings: number
  exhibits: number
  read: number
  statements: number
  failed: number
  audio: {
    collected: number
    submitted: number
    pending: number
    /** This month's spend on calls since BACKFILL_BEFORE. */
    spent_usd: number
    /** The backfill's spend, all time, against BACKFILL_SPEND_CAP_USD. */
    backfill_spent_usd: number
  }
  concepts: number
  resolved: number
}

const docId = (url: string) => contentHash({ call_document: url })

async function fail(db: PipelineDb, detail: string): Promise<void> {
  await recordOpsEvent(db, { kind: KIND_CALL_READ_FAILED, detail })
}

/** The quarter a call on `date` reported, for a company. */
function reported(c: CallCompany, date: string) {
  const q = reportedQuarter(c.fy_end_month, date)
  return { q, label: periodLabel(c.fy_end_month, q) }
}

/** Step 1: every curated document not held yet. */
export async function syncCurated(db: PipelineDb, now: Date): Promise<number> {
  const at = now.toISOString()
  const ids = curatedCalls.documents.map((d) => docId(d.url))
  const held = new Set<string>()
  for (const part of chunk(ids, D1_MAX_BOUND_PARAMS - 1)) {
    const rows = await db
      .select({ id: tables.callDocuments.id })
      .from(tables.callDocuments)
      .where(inArray(tables.callDocuments.id, part))
    for (const r of rows) held.add(r.id)
  }
  let added = 0
  for (const d of curatedCalls.documents) {
    const id = docId(d.url)
    if (held.has(id)) continue
    const { q, label } = reported(callCompany(d.ticker), d.call_date)
    await db
      .insert(tables.callDocuments)
      .values({
        id,
        ticker: d.ticker,
        call_date: d.call_date,
        period_label: label,
        fiscal_year: q.fiscal_year,
        fiscal_quarter: q.quarter!,
        kind: d.kind,
        url: d.url,
        page_url: d.page_url,
        produced_by: d.kind === 'audio' ? 'AssemblyAI' : d.produced_by,
        accession_no: null,
        status: d.job_id ? 'submitted' : 'pending',
        job_id: d.job_id ?? null,
        submitted_at: d.submitted_at ?? null,
        cost_usd: d.estimate_usd ?? null,
        first_seen_at: at,
        source_url: d.url,
        fetched_at: at,
      })
      .onConflictDoNothing()
    added++
  }
  return added
}

/** The tickers whose submissions feed was read longest ago (never read first). */
async function staleTickers(db: PipelineDb, n: number): Promise<string[]> {
  const rows = await db
    .select({
      ticker: tables.filedFactReads.ticker,
      at: sql<string>`max(${tables.filedFactReads.started_at})`,
    })
    .from(tables.filedFactReads)
    .where(eq(tables.filedFactReads.kind, 'call-submissions'))
    .groupBy(tables.filedFactReads.ticker)
  const last = new Map(rows.map((r) => [r.ticker, r.at]))
  return curatedCalls.companies
    .map((c) => c.ticker)
    .sort((a, b) => (last.get(a) ?? '').localeCompare(last.get(b) ?? '') || a.localeCompare(b))
    .slice(0, n)
}

async function logRead(
  db: PipelineDb,
  row: {
    ticker: string
    kind: string
    status: string
    detail: string | null
    url: string
    facts: number
  },
  now: Date,
) {
  await db.insert(tables.filedFactReads).values({
    id: contentHash({ read: row.kind, ticker: row.ticker, url: row.url, at: now.toISOString() }),
    ticker: row.ticker,
    kind: row.kind,
    accession_no: null,
    status: row.status,
    detail: row.detail,
    content_hash: null,
    facts: row.facts,
    started_at: now.toISOString(),
    source_url: row.url,
  })
}

interface Listed {
  form: '8-K' | '6-K'
  filed: string
  cik: string
}

const READ_COLUMNS = 10
export const LISTED_ROWS_PER_STATEMENT = Math.floor(D1_MAX_BOUND_PARAMS / READ_COLUMNS)

/**
 * Lists filings, or re-lists ones whose index read failed. The update reads only
 * `excluded`: a bound value in `set` adds to the rows' parameters, and a full chunk
 * then passes D1's cap (the backfill's first runs failed at 102).
 */
export function upsertListed(db: PipelineDb, rows: (typeof tables.filedFactReads.$inferInsert)[]) {
  return db
    .insert(tables.filedFactReads)
    .values(rows)
    .onConflictDoUpdate({
      target: tables.filedFactReads.id,
      set: {
        status: sql`excluded.status`,
        detail: sql`excluded.detail`,
        started_at: sql`excluded.started_at`,
      },
    })
}

/** The submissions feeds of a company: its own, and its earlier CIK's until it redomiciled. */
function feedsOf(c: CallCompany): { cik: string; until: string | null }[] {
  return [{ cik: c.cik, until: null }, ...(c.prior_cik ? [c.prior_cik] : [])]
}

/** The first day a company's calls are read from. */
export const callsSince = (c: Pick<CallCompany, 'history_from'>) =>
  c.history_from && c.history_from > BACKFILL_SINCE ? c.history_from : BACKFILL_SINCE

/**
 * Step 2a: list each earnings filing of a few tickers not listed yet. A feed's
 * paged files hold filings that never change, so each is read until it reads
 * cleanly once; the listed filings wait as `listed` rows for step 2b.
 */
export async function listFilings(db: PipelineDb, deps: CallDeps): Promise<number> {
  const at = deps.now.toISOString()
  const limits = { ...CALL_LIMITS, ...deps.limits }
  let listed = 0
  for (const ticker of await staleTickers(db, limits.submissions)) {
    const c = callCompany(ticker)
    const since = callsSince(c)
    const known = new Set(
      (
        await db
          .select({ accession_no: tables.filedFactReads.accession_no })
          .from(tables.filedFactReads)
          .where(
            and(
              eq(tables.filedFactReads.ticker, ticker),
              eq(tables.filedFactReads.kind, 'call-filing'),
              ne(tables.filedFactReads.status, 'failed'),
            ),
          )
      ).map((r) => r.accession_no),
    )
    const pagesRead = new Set(
      (
        await db
          .select({ url: tables.filedFactReads.source_url })
          .from(tables.filedFactReads)
          .where(
            and(
              eq(tables.filedFactReads.ticker, ticker),
              eq(tables.filedFactReads.kind, 'call-submissions-page'),
              eq(tables.filedFactReads.status, 'ok'),
            ),
          )
      ).map((r) => r.url),
    )
    let found = 0
    let failed: string | null = null
    for (const feed of feedsOf(c)) {
      const url = `https://data.sec.gov/submissions/CIK${feed.cik}.json`
      const res = await deps.fetcher({ source_id: 'call-edgar-submissions', url, ext: 'json' })
      if (!res.ok) {
        failed = `${url}: ${res.detail}`
        break
      }
      const filings: EarningsFiling[] = []
      let pages: string[]
      try {
        filings.push(...earningsFilings(res.text, feed.cik, since))
        pages = olderPages(res.text, feed.cik, since).filter((p) => !pagesRead.has(p))
      } catch (error) {
        failed = `${url}: ${String(error)}`
        break
      }
      const pageReads: { url: string; detail: string | null; facts: number }[] = []
      for (const page of pages) {
        const pres = await deps.fetcher({
          source_id: 'call-edgar-submissions',
          url: page,
          ext: 'json',
        })
        let rows: EarningsFiling[] = []
        let detail: string | null = pres.ok ? null : pres.detail
        if (pres.ok) {
          try {
            rows = pageFilings(pres.text, feed.cik, since)
          } catch (error) {
            detail = String(error)
          }
        }
        filings.push(...rows)
        pageReads.push({ url: page, detail, facts: rows.length })
      }
      const fresh = filings.filter(
        (f) => !known.has(f.accession_no) && (feed.until === null || f.filed <= feed.until),
      )
      const values = fresh.map((f) => ({
        id: contentHash({ read: 'call-filing', accession: f.accession_no }),
        ticker,
        kind: 'call-filing',
        accession_no: f.accession_no,
        status: 'listed',
        detail: JSON.stringify({ form: f.form, filed: f.filed, cik: feed.cik } satisfies Listed),
        content_hash: null,
        facts: 0,
        started_at: at,
        source_url: f.index_url,
      }))
      for (const part of chunk(values, LISTED_ROWS_PER_STATEMENT)) {
        await upsertListed(db, part)
      }
      for (const f of fresh) known.add(f.accession_no)
      found += fresh.length
      // A page counts as read only once its filings are listed.
      for (const p of pageReads) {
        await logRead(
          db,
          {
            ticker,
            kind: 'call-submissions-page',
            status: p.detail ? 'failed' : 'ok',
            detail: p.detail,
            url: p.url,
            facts: p.facts,
          },
          deps.now,
        )
        if (p.detail) await fail(db, `${ticker} ${p.url}: ${p.detail}`)
      }
    }
    const url = `https://data.sec.gov/submissions/CIK${c.cik}.json`
    await logRead(
      db,
      {
        ticker,
        kind: 'call-submissions',
        status: failed ? 'failed' : 'ok',
        detail: failed,
        url,
        facts: found,
      },
      deps.now,
    )
    if (failed) await fail(db, `${ticker} submissions: ${failed}`)
    listed += found
  }
  return listed
}

/** Step 2b: the index pages of listed filings, newest filing first, and the EX-99 exhibits on each. */
export async function readFilingIndexes(
  db: PipelineDb,
  deps: CallDeps,
): Promise<{ filings: number; exhibits: number }> {
  const at = deps.now.toISOString()
  const limits = { ...CALL_LIMITS, ...deps.limits }
  const queue = await db
    .select()
    .from(tables.filedFactReads)
    .where(
      and(
        eq(tables.filedFactReads.kind, 'call-filing'),
        eq(tables.filedFactReads.status, 'listed'),
      ),
    )
    .orderBy(
      desc(sql`json_extract(${tables.filedFactReads.detail}, '$.filed')`),
      asc(tables.filedFactReads.id),
    )
    .limit(limits.indexPages)
  let filings = 0
  let exhibits = 0
  for (const row of queue) {
    const c = CALL_COMPANIES.get(row.ticker)
    if (!c || !row.accession_no) continue
    const f = JSON.parse(row.detail ?? '{}') as Partial<Listed>
    if (!f.form || !f.filed || !f.cik) continue
    const idx = await deps.fetcher({
      source_id: 'call-edgar-index',
      url: row.source_url,
      ext: 'html',
    })
    let list: Exhibit[] = []
    let detail: string | null = null
    if (idx.ok) {
      try {
        const skip = c.skip_exhibits ? new RegExp(c.skip_exhibits, 'i') : undefined
        list = earningsExhibits(idx.text, f.cik, row.accession_no, f.form, skip)
      } catch (error) {
        detail = String(error)
      }
    } else detail = idx.detail
    await db
      .update(tables.filedFactReads)
      .set({ status: detail ? 'failed' : 'ok', detail, facts: list.length, started_at: at })
      .where(eq(tables.filedFactReads.id, row.id))
    if (detail) continue
    filings++
    const { q, label } = reported(c, f.filed)
    for (const e of list) {
      const written = await db
        .insert(tables.callDocuments)
        .values({
          id: docId(e.url),
          ticker: row.ticker,
          call_date: f.filed,
          period_label: label,
          fiscal_year: q.fiscal_year,
          fiscal_quarter: q.quarter!,
          kind: 'exhibit',
          url: e.url,
          page_url: row.source_url,
          produced_by: e.type,
          accession_no: row.accession_no,
          status: 'pending',
          first_seen_at: at,
          source_url: e.url,
          fetched_at: at,
        })
        .onConflictDoNothing()
        .returning({ id: tables.callDocuments.id })
      exhibits += written.length
    }
  }
  return { filings, exhibits }
}

/** Step 2: new earnings filings and their exhibits, then the backfill's, newest first. */
export async function discoverExhibits(
  db: PipelineDb,
  deps: CallDeps,
): Promise<{ filings: number; exhibits: number; listed: number }> {
  const listed = await listFilings(db, deps)
  return { listed, ...(await readFilingIndexes(db, deps)) }
}

type Doc = typeof tables.callDocuments.$inferSelect

/** The guidance rows of one document's statements. */
export function guidanceRows(
  doc: Doc,
  c: CallCompany,
  statements: readonly Statement[],
  prov: { raw_key: string; now: string; method: 'parser' | 'judge' },
): (typeof tables.filedGuidance.$inferInsert)[] {
  const source = doc.kind === 'audio' ? 'audio' : doc.kind
  return statements.map((s) => ({
    id: contentHash({
      guidance: doc.id,
      metric: s.metric,
      segment: s.segment,
      unit: s.unit,
      end: s.period.end,
      low: s.low,
      high: s.high,
    }),
    ticker: doc.ticker,
    cik: c.cik,
    accession_no: doc.accession_no ?? '',
    filed: doc.call_date,
    fiscal_year: s.period.fiscal_year,
    fiscal_quarter: s.period.quarter,
    low: s.low,
    high: s.high,
    sentence: s.quote,
    raw_key: prov.raw_key,
    first_seen_at: prov.now,
    source,
    metric: s.metric,
    segment: s.segment,
    basis: s.basis,
    unit: s.unit,
    bound: s.bound,
    period_start: s.period.start,
    period_end: s.period.end,
    speaker: s.speaker,
    at_ms: s.at_ms,
    page: s.page,
    call_document_id: doc.id,
    page_url: doc.page_url,
    method: prov.method,
    source_url: doc.url,
    fetched_at: prov.now,
  }))
}

/** Store a document's sentences privately and its statements publicly; mark it read. */
export async function settleDocument(
  db: PipelineDb,
  deps: Pick<CallDeps, 'raw' | 'now'>,
  doc: Doc,
  sentences: readonly DocSentence[],
  extra: Partial<Doc> = {},
): Promise<number> {
  const now = deps.now.toISOString()
  const c = callCompany(doc.ticker)
  const body = JSON.stringify({ url: doc.url, sentences })
  const hash = contentHashOfText(body)
  const raw_key = `calls/${doc.ticker.toLowerCase()}/${doc.id.slice(0, 24)}.json`
  await deps.raw.put(raw_key, body, 'application/json')
  const { q } = reported(c, doc.call_date)
  const statements = extractStatements(sentences, {
    fyEndMonth: c.fy_end_month,
    reported: q,
    speakers: doc.kind === 'audio' && c.speakers ? c.speakers.map((s) => s.name) : undefined,
  })
  const rows = guidanceRows(doc, c, statements, { raw_key, now, method: 'parser' })
  for (const part of chunk(rows, 3)) {
    if (part.length) await db.insert(tables.filedGuidance).values(part).onConflictDoNothing()
  }
  await db
    .update(tables.callDocuments)
    .set({
      status: 'read',
      detail: sentences.length ? null : 'no text',
      raw_key,
      content_hash: hash,
      statements: rows.length,
      read_at: now,
      fetched_at: now,
      ...extra,
    })
    .where(eq(tables.callDocuments.id, doc.id))
  return rows.length
}

async function markFailed(db: PipelineDb, doc: Doc, detail: string, now: Date) {
  await db
    .update(tables.callDocuments)
    .set({
      status: doc.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'pending',
      detail: detail.slice(0, 300),
      attempts: doc.attempts + 1,
      fetched_at: now.toISOString(),
    })
    .where(eq(tables.callDocuments.id, doc.id))
}

const isPdf = (bytes: Uint8Array) =>
  bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
const isZip = (bytes: Uint8Array) =>
  bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04

/** One text document's sentences: a PDF's pages, a Word file's paragraphs, or an HTML page's blocks. */
export async function documentSentences(
  doc: Pick<Doc, 'url'>,
  deps: Pick<CallDeps, 'fetcher' | 'fetch' | 'userAgent'>,
): Promise<{ ok: true; sentences: DocSentence[] } | { ok: false; detail: string }> {
  if (new URL(doc.url).hostname.endsWith('sec.gov')) {
    const res = await deps.fetcher({ source_id: 'call-edgar-exhibit', url: doc.url, ext: 'html' })
    return res.ok
      ? { ok: true, sentences: htmlSentences(res.text) }
      : { ok: false, detail: res.detail }
  }
  const ua = deps.userAgent(doc.url)
  if (!ua) return { ok: false, detail: 'no user agent for host' }
  const res = await (deps.fetch ?? globalThis.fetch)(doc.url, {
    headers: { 'User-Agent': ua, Accept: '*/*' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > DOC_MAX_BYTES) return { ok: false, detail: `body exceeds ${DOC_MAX_BYTES} bytes` }
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength > DOC_MAX_BYTES)
    return { ok: false, detail: `body exceeds ${DOC_MAX_BYTES} bytes` }
  if (isPdf(bytes)) {
    try {
      return { ok: true, sentences: await pdfSentences(bytes) }
    } catch (error) {
      return { ok: false, detail: `pdf: ${String(error)}` }
    }
  }
  if (isZip(bytes)) {
    try {
      return { ok: true, sentences: await docxSentences(bytes) }
    } catch (error) {
      return { ok: false, detail: `docx: ${String(error)}` }
    }
  }
  return { ok: true, sentences: htmlSentences(new TextDecoder().decode(bytes)) }
}

/** Step 3: text documents not read yet, newest call first, so a new call is never behind the backfill. */
export async function readTextDocuments(
  db: PipelineDb,
  deps: CallDeps,
): Promise<{ read: number; statements: number; failed: number }> {
  const retryBefore = new Date(deps.now.getTime() - RETRY_AFTER_MS).toISOString()
  const pending = await db
    .select()
    .from(tables.callDocuments)
    .where(
      and(
        eq(tables.callDocuments.status, 'pending'),
        ne(tables.callDocuments.kind, 'audio'),
        sql`(${tables.callDocuments.attempts} = 0 or ${tables.callDocuments.fetched_at} < ${retryBefore})`,
      ),
    )
    .orderBy(desc(tables.callDocuments.call_date), asc(tables.callDocuments.id))
    .limit({ ...CALL_LIMITS, ...deps.limits }.textDocs)
  let read = 0
  let statements = 0
  let failed = 0
  for (const doc of pending) {
    let got
    try {
      got = await documentSentences(doc, deps)
    } catch (error) {
      got = { ok: false as const, detail: `fetch threw: ${String(error)}` }
    }
    if (!got.ok) {
      failed++
      await markFailed(db, doc, got.detail, deps.now)
      if (doc.attempts + 1 >= MAX_ATTEMPTS)
        await fail(db, `${doc.ticker} ${doc.url}: ${got.detail}`)
      continue
    }
    statements += await settleDocument(db, deps, doc, got.sentences)
    read++
  }
  return { read, statements, failed }
}

/**
 * AssemblyAI spend on one basis: billed for finished jobs, estimated for
 * running ones, and an hour for a job sent from the mini with no estimate.
 * The month's is the calls since BACKFILL_BEFORE submitted in the UTC month
 * of `now` (dated by submission, or first sight); the backfill's is every
 * older call's, ever.
 */
export async function assemblySpend(
  db: PipelineDb,
  now: Date,
  basis: SpendBasis = 'monthly',
): Promise<number> {
  const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00Z`
  const d = tables.callDocuments
  const [row] = await db
    .select({
      usd: sql<number | null>`sum(${d.cost_usd})`,
      unestimated: sql<
        number | null
      >`sum(case when ${d.cost_usd} is null and ${d.status} = 'submitted' then 1 else 0 end)`,
    })
    .from(d)
    .where(
      and(
        eq(d.kind, 'audio'),
        basis === 'backfill'
          ? lt(d.call_date, BACKFILL_BEFORE)
          : and(
              sql`${d.call_date} >= ${BACKFILL_BEFORE}`,
              sql`coalesce(${d.submitted_at}, ${d.first_seen_at}) >= ${monthStart}`,
            ),
      ),
    )
  return (row?.usd ?? 0) + (row?.unestimated ?? 0) * costOf(3600)
}

const CAP: Record<SpendBasis, number> = {
  monthly: MONTHLY_SPEND_CAP_USD,
  backfill: BACKFILL_SPEND_CAP_USD,
}

/** A replay's length from its size and its MP3 header, as an upper bound when the header can't be read. */
async function estimateSeconds(
  url: string,
  deps: Pick<CallDeps, 'fetch' | 'userAgent'>,
): Promise<number | null> {
  const ua = deps.userAgent(url)
  if (!ua) return null
  const res = await (deps.fetch ?? globalThis.fetch)(url, {
    headers: { 'User-Agent': ua, Range: 'bytes=0-65535' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) return null
  const total = Number(
    res.headers.get('content-range')?.split('/')[1] ?? res.headers.get('content-length'),
  )
  const head = new Uint8Array(await res.arrayBuffer())
  if (!Number.isFinite(total) || total <= 0) return null
  return replaySeconds(head, total)
}

/** Step 4: collect finished jobs, then submit new replays under the cap. */
export async function runAudio(
  db: PipelineDb,
  deps: CallDeps,
): Promise<CallReadReport['audio'] & { statements: number }> {
  const out = {
    collected: 0,
    submitted: 0,
    pending: 0,
    spent_usd: 0,
    backfill_spent_usd: 0,
    statements: 0,
  }
  if (!deps.assemblyKey) return out
  const doFetch = deps.fetch ?? globalThis.fetch
  const headers = { authorization: deps.assemblyKey }
  const audio = await db
    .select()
    .from(tables.callDocuments)
    .where(
      and(
        eq(tables.callDocuments.kind, 'audio'),
        inArray(tables.callDocuments.status, ['submitted', 'pending']),
      ),
    )
    .orderBy(asc(tables.callDocuments.call_date))
  for (const doc of audio.filter((d) => d.status === 'submitted' && d.job_id)) {
    const res = await doFetch(`${ASSEMBLYAI_API}/v2/transcript/${doc.job_id}`, { headers })
    const body = await res.text()
    if (!res.ok) {
      if (refusalOf(res.status, body) !== 'other') {
        await recordOpsEvent(db, {
          kind: KIND_ASSEMBLYAI_CREDITS,
          detail: `HTTP ${res.status} reading ${doc.job_id}: ${body.slice(0, 200)}`,
        })
        return out
      }
      continue
    }
    const job = JSON.parse(body) as { status?: string; error?: string; audio_duration?: number }
    if (job.status === 'error') {
      await markFailed(
        db,
        { ...doc, attempts: MAX_ATTEMPTS },
        `assemblyai: ${job.error ?? 'error'}`,
        deps.now,
      )
      await fail(db, `${doc.ticker} ${doc.call_date} transcript failed: ${job.error ?? 'error'}`)
      continue
    }
    if (job.status !== 'completed') {
      out.pending++
      continue
    }
    const sres = await doFetch(`${ASSEMBLYAI_API}/v2/transcript/${doc.job_id}/sentences`, {
      headers,
    })
    if (!sres.ok) continue
    let spoken
    try {
      spoken = parseSentences(await sres.text(), speakerMapping(job))
    } catch (error) {
      await fail(db, `${doc.ticker} ${doc.job_id} sentences: ${String(error)}`)
      continue
    }
    const seconds = job.audio_duration ?? null
    out.statements += await settleDocument(db, deps, doc, spokenSentences(spoken), {
      audio_seconds: seconds,
      cost_usd: seconds === null ? doc.cost_usd : costOf(seconds),
    })
    out.collected++
  }
  const spent: Record<SpendBasis, number> = {
    monthly: await assemblySpend(db, deps.now, 'monthly'),
    backfill: await assemblySpend(db, deps.now, 'backfill'),
  }
  const capped = new Set<SpendBasis>()
  // New calls first: a replay since BACKFILL_BEFORE never waits behind the backfill.
  const pending = audio
    .filter((d) => d.status === 'pending')
    .sort((a, b) => b.call_date.localeCompare(a.call_date))
  const maxSubmits = { ...CALL_LIMITS, ...deps.limits }.audioSubmits
  let tries = 0
  for (const doc of pending) {
    if (tries >= maxSubmits) break
    const basis = spendBasis(doc.call_date)
    if (capped.has(basis)) continue
    tries++
    const seconds = await estimateSeconds(doc.url, deps).catch(() => null)
    if (seconds === null) {
      await markFailed(db, doc, 'replay not reachable', deps.now)
      continue
    }
    const estimate = costOf(seconds)
    if (spent[basis] + estimate > CAP[basis]) {
      capped.add(basis)
      await recordOpsEvent(db, {
        kind: KIND_ASSEMBLYAI_CREDITS,
        detail:
          basis === 'backfill'
            ? `backfill ceiling: $${spent.backfill.toFixed(2)} spent of $${BACKFILL_SPEND_CAP_USD}; ${doc.ticker} ${doc.call_date} not submitted`
            : `spend cap: $${spent.monthly.toFixed(2)} spent this month of $${MONTHLY_SPEND_CAP_USD}; ${doc.ticker} ${doc.call_date} not submitted`,
      })
      continue
    }
    const res = await doFetch(`${ASSEMBLYAI_API}/v2/transcript`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(transcriptRequest(doc.url, callCompany(doc.ticker))),
    })
    const body = await res.text()
    if (!res.ok) {
      if (refusalOf(res.status, body) !== 'other') {
        await recordOpsEvent(db, {
          kind: KIND_ASSEMBLYAI_CREDITS,
          detail: `HTTP ${res.status} on submit: ${body.slice(0, 200)}`,
        })
        break
      }
      await markFailed(db, doc, `submit HTTP ${res.status}: ${body.slice(0, 200)}`, deps.now)
      continue
    }
    const job = JSON.parse(body) as { id?: string }
    if (!job.id) continue
    spent[basis] += estimate
    out.submitted++
    await db
      .update(tables.callDocuments)
      .set({
        status: 'submitted',
        job_id: job.id,
        cost_usd: estimate,
        submitted_at: deps.now.toISOString(),
      })
      .where(eq(tables.callDocuments.id, doc.id))
  }
  out.spent_usd = spent.monthly
  out.backfill_spent_usd = spent.backfill
  return out
}

type GuidanceRow = typeof tables.filedGuidance.$inferSelect

/** Call guidance rows not resolved yet whose period has ended. */
async function openStatements(db: PipelineDb, today: string): Promise<GuidanceRow[]> {
  return db
    .select()
    .from(tables.filedGuidance)
    .leftJoin(
      tables.guidanceResolutions,
      eq(tables.guidanceResolutions.guidance_id, tables.filedGuidance.id),
    )
    .where(
      and(
        inArray(tables.filedGuidance.source, [...CALL_SOURCES]),
        isNull(tables.guidanceResolutions.id),
        lt(tables.filedGuidance.period_end, today),
      ),
    )
    .then((rows) => rows.map((r) => r.filed_guidance))
}

/** The concept facts held for a ticker. */
export async function conceptFacts(db: PipelineDb, ticker: string): Promise<ConceptFact[]> {
  return db
    .select({
      concept: tables.filedFacts.concept,
      start: tables.filedFacts.start,
      end: tables.filedFacts.end,
      value: tables.filedFacts.value,
      form: tables.filedFacts.form,
      filed: tables.filedFacts.filed,
      accession_no: tables.filedFacts.accession_no,
      source_url: tables.filedFacts.source_url,
      fetched_at: tables.filedFacts.fetched_at,
    })
    .from(tables.filedFacts)
    .where(
      and(
        eq(tables.filedFacts.ticker, ticker),
        eq(tables.filedFacts.dims, ''),
        eq(tables.filedFacts.unit, 'USD'),
      ),
    )
}

/** Step 5a: the XBRL concepts open statements need, oldest read first, once a day each. */
export async function readConcepts(
  db: PipelineDb,
  deps: CallDeps,
  open: readonly GuidanceRow[],
  /** Concepts other layers need read, with the filer's CIK (server/registries/call-concepts.ts). */
  extra: readonly ConceptNeed[] = [],
): Promise<number> {
  const dayAgo = new Date(deps.now.getTime() - 86_400_000).toISOString()
  const wanted: { ticker: string; concept: string; cik: string }[] = []
  const byTicker = new Map<string, GuidanceRow[]>()
  for (const g of open) {
    if (unscorable(g.ticker, g)) continue
    byTicker.set(g.ticker, [...(byTicker.get(g.ticker) ?? []), g])
  }
  for (const [ticker, rows] of byTicker) {
    const c = CALL_COMPANIES.get(ticker)
    if (!c) continue
    // A redomiciled filer's earlier quarters are in its earlier CIK's facts.
    const prior =
      c.prior_cik && rows.some((r) => (r.period_start ?? '') <= c.prior_cik!.until)
        ? c.prior_cik.cik
        : null
    for (const concept of neededConcepts(ticker, rows)) {
      wanted.push({ ticker, concept, cik: c.cik })
      if (prior) wanted.push({ ticker, concept, cik: prior })
    }
  }
  const asked = new Set(wanted.map((w) => `${w.ticker}|${w.concept}`))
  for (const w of extra) {
    if (!asked.has(`${w.ticker}|${w.concept}`)) wanted.push(w)
  }
  if (!wanted.length) return 0
  const recent = await db
    .select({ ticker: tables.filedFactReads.ticker, url: tables.filedFactReads.source_url })
    .from(tables.filedFactReads)
    .where(
      and(
        eq(tables.filedFactReads.kind, 'companyconcept'),
        sql`${tables.filedFactReads.started_at} > ${dayAgo}`,
      ),
    )
  const done = new Set(recent.map((r) => r.url))
  let reads = 0
  for (const w of wanted) {
    if (reads >= { ...CALL_LIMITS, ...deps.limits }.conceptReads) break
    const url = conceptUrl(w.cik, w.concept)
    if (done.has(url)) continue
    reads++
    const res = await deps.fetcher({ source_id: 'call-edgar-companyconcept', url, ext: 'json' })
    if (!res.ok) {
      // A concept the filer never tagged answers 404: recorded, and not a failure.
      await logRead(
        db,
        {
          ticker: w.ticker,
          kind: 'companyconcept',
          status: res.status === 404 ? 'ok' : 'failed',
          detail: res.detail,
          url,
          facts: 0,
        },
        deps.now,
      )
      if (res.status !== 404) await fail(db, `${w.ticker} ${w.concept}: ${res.detail}`)
      continue
    }
    let facts
    try {
      facts = parseCompanyConcept(res.text, w.cik)
    } catch (error) {
      await logRead(
        db,
        {
          ticker: w.ticker,
          kind: 'companyconcept',
          status: 'failed',
          detail: String(error),
          url,
          facts: 0,
        },
        deps.now,
      )
      continue
    }
    const now = deps.now.toISOString()
    const raw_key = `calls/facts/${w.ticker.toLowerCase()}/${w.concept.split(':')[1]}-${contentHashOfText(res.text).slice(0, 16)}.json`
    await deps.raw.put(raw_key, res.text, 'application/json')
    const rows = facts
      .filter((f) => f.end >= FACTS_SINCE)
      .map((f) => ({
        id: contentHash({
          ticker: w.ticker,
          concept: f.concept,
          dims: '',
          start: f.start,
          end: f.end,
          accession_no: f.accession_no,
        }),
        ticker: w.ticker,
        cik: w.cik,
        concept: f.concept,
        dims: '',
        start: f.start,
        end: f.end,
        value: f.value,
        unit: 'USD',
        form: f.form,
        filed: f.filed,
        accession_no: f.accession_no,
        basis: 'companyconcept',
        raw_key,
        first_seen_at: now,
        source_url: url,
        fetched_at: now,
      }))
    for (const part of chunk(rows, Math.floor(D1_MAX_BOUND_PARAMS / 17))) {
      await db.insert(tables.filedFacts).values(part).onConflictDoNothing()
    }
    await logRead(
      db,
      {
        ticker: w.ticker,
        kind: 'companyconcept',
        status: 'ok',
        detail: null,
        url,
        facts: rows.length,
      },
      deps.now,
    )
  }
  return reads
}

/** Step 5b: each open statement the held facts now settle. */
export async function resolveStatements(
  db: PipelineDb,
  open: readonly GuidanceRow[],
  now: Date,
): Promise<number> {
  let resolved = 0
  const facts = new Map<string, ConceptFact[]>()
  for (const g of open) {
    if (unscorable(g.ticker, g) || !g.period_start || !g.period_end) continue
    const c = CALL_COMPANIES.get(g.ticker)
    if (!c) continue
    if (!facts.has(g.ticker)) facts.set(g.ticker, await conceptFacts(db, g.ticker))
    const period = {
      ...fiscalPeriod(c.fy_end_month, g.fiscal_year, g.fiscal_quarter),
      start: g.period_start,
      end: g.period_end,
    }
    const actual = actualFor(g.ticker, g, period, c.fy_end_month, facts.get(g.ticker)!)
    // A figure filed with or before the call isn't a forecast of it.
    if (!actual || actual.filed <= g.filed) continue
    const scored = score(g, actual.value)
    if (!scored) continue
    await db
      .insert(tables.guidanceResolutions)
      .values({
        id: contentHash({ resolution: g.id, accession: actual.accession_no }),
        guidance_id: g.id,
        ticker: g.ticker,
        metric: g.metric,
        actual: actual.value,
        guided_mid: scored.guided_mid,
        error_share: scored.error_share,
        state: scored.state,
        concept: actual.concept,
        form: actual.form,
        filed: actual.filed,
        accession_no: actual.accession_no,
        first_seen_at: now.toISOString(),
        source_url: actual.source_url,
        fetched_at: actual.fetched_at,
      })
      .onConflictDoNothing()
    resolved++
  }
  return resolved
}

/** One whole run. Each step's failure is spooled; the others still run. */
export async function runCallReads(db: PipelineDb, deps: CallDeps): Promise<CallReadReport> {
  const report: CallReadReport = {
    curated: 0,
    listed: 0,
    filings: 0,
    exhibits: 0,
    read: 0,
    statements: 0,
    failed: 0,
    audio: { collected: 0, submitted: 0, pending: 0, spent_usd: 0, backfill_spent_usd: 0 },
    concepts: 0,
    resolved: 0,
  }
  const step = async (name: string, f: () => Promise<void>) => {
    try {
      await f()
    } catch (error) {
      await fail(db, `${name} threw: ${String(error)}`)
    }
  }
  await step('curated', async () => {
    report.curated = await syncCurated(db, deps.now)
  })
  await step('edgar', async () => {
    Object.assign(report, await discoverExhibits(db, deps))
  })
  await step('text', async () => {
    const r = await readTextDocuments(db, deps)
    report.read = r.read
    report.statements += r.statements
    report.failed = r.failed
  })
  await step('audio', async () => {
    const { statements, ...audio } = await runAudio(db, deps)
    report.audio = audio
    report.statements += statements
  })
  await step('resolve', async () => {
    const today = deps.now.toISOString().slice(0, 10)
    const open = await openStatements(db, today)
    const extra = (await Promise.all(CALL_CONCEPT_NEEDS.map((need) => need(db, today)))).flat()
    report.concepts = await readConcepts(db, deps, open, extra)
    report.resolved = await resolveStatements(db, open, deps.now)
  })
  return report
}
