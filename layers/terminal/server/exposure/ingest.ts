// One run of the filed-facts reader, after each edgar tick's poll (every 30
// minutes, never at the survey instant: filedFactsSkip): for each hyperscaler
// in sources.yaml `filed_fact_sources`,
//
//   1. its submissions feed, for the 10-Q/10-K list (small, every run);
//   2. its company facts, every six hours, or every run while a filing from
//      the last two weeks has not reached them yet;
//   3. for a filer with `instances: true`, each 10-Q/10-K instance since 2020
//      not yet read, newest first, at most INSTANCES_PER_RUN a run across
//      filers. The first runs back-fill the history; after that a run reads
//      only what was just filed. An instance read once is never fetched
//      again: a filing does not change after it is accepted;
//   4. each earnings release (an 8-K with item 2.02) since GUIDANCE_SINCE not
//      yet read, for the capex guidance it prints (guidance.ts): the filing's
//      index page, then its exhibit 99.1, at most RELEASES_PER_RUN a run;
//   5. for a filer in TEXT_FACT_FILERS, each 10-Q/10-K primary document in
//      its window not yet read, for what it says about a lab in words before
//      it tagged it (text-facts.ts), at most TEXTS_PER_RUN a run. The window
//      is closed, so these reads end once its filings are read.
//
// Facts are append-only (filed_facts). The raw bytes of every document that
// produced facts go to R2 first, so each row's raw_key resolves. Then the
// filed-fact rule (alerts.ts) runs over each filer that gained facts, and the
// guidance rule (guidance-alerts.ts) over each that gained facts or guidance.
//
// Every request goes to SEC, under its fair-access limit (pipeline/sec-pace.ts).
// When SEC answers 429 the run stops fetching: the rest of the run is deferred,
// the 429 is stored as a failed read so the next runs sit out the cooldown
// (pipeline/rate-limit.ts, a longer Retry-After extends it), and the tick
// raises one summarised ops event rather than one per document. The 429'd
// document is read again after the cooldown, not held back a day.

import { and, desc, eq, inArray, like, min } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'
import { contentHash, contentHashOfText } from '../pipeline/contracts'
import { RATE_LIMITED_DETAIL, type FetchOutcome, type SourceFetcher } from '../pipeline/fetch'
import type { RawReader } from '../pipeline/judge/class-map'
import { parseCikWhitelistBlock } from '../pipeline/parsers/sec/whitelist'
import type { PollOutcome } from '../pipeline/poll'
import { cooldownEndsAt, isRateLimitRun } from '../pipeline/rate-limit'
import type { RawStore } from '../pipeline/refresh'
import type { FetchSource } from '../pipeline/sources'
import { chunk, D1_MAX_BOUND_PARAMS, runStatements, type PipelineDb } from '../pipeline/store'
import { readFiledFactSources } from '../utils/terminal-sources'
import { FRESH_DAYS, filedFactAlert } from './alerts'
import {
  extractCompanyfacts,
  extractInstanceFacts,
  instanceDocuments,
  type FactInput,
  type InstanceDocument,
} from './facts'
import {
  GUIDANCE_SINCE,
  exhibitUrl,
  extractGuidance,
  releaseDocuments,
  type GuidanceInput,
  type ReleaseDocument,
} from './guidance'
import { writeGuidanceAlerts } from './guidance-alerts'
import { TEXT_FACT_FILERS, extractTextFacts, type TextFact } from './text-facts'
import {
  LAB_MEMBERS,
  SERIES_SINCE,
  buildSeries,
  earlierPoints,
  isAlerting,
  type StoredFact,
} from './series'

export const INSTANCES_PER_RUN = 24
/** Two requests each: the filing's index page, then the release. */
export const RELEASES_PER_RUN = 4
/** A primary document runs to 7 MB, so few a run. */
export const TEXTS_PER_RUN = 2
export const COMPANYFACTS_INTERVAL_MS = 6 * 60 * 60 * 1000
/** A failed instance is retried after this long, not every run. */
export const FAILED_RETRY_MS = 24 * 60 * 60 * 1000

const FACT_COLUMNS = 17

export interface FiledFactsDeps {
  raw: RawStore
  /** Reads back what `raw` stored: a guidance figure alerts only once its sentence is found in the stored release. */
  readRaw: RawReader
  fetcher: SourceFetcher
  now: Date
  sourcesYaml: string
}

export interface FiledFactsReport {
  reads: {
    ticker: string
    kind: string
    accession_no: string | null
    status: string
    facts: number
  }[]
  alerts: number
  /** Requests not made this run because SEC answered 429 (the 429'd one included). */
  deferred: number
  /** Set when an earlier 429's cooldown kept this run from fetching at all. */
  cooling_until: string | null
}

/**
 * Why the edgar tick leaves the filed facts out, or null to run them. They run
 * only after a poll that ran: at the survey instant the poll yields, and the
 * survey is fetching every SEC feed in another invocation; a held lock means
 * another poll is fetching right now. A 429 from SEC earlier in the tick means
 * SEC wants less, not more. The next tick, thirty minutes on, picks them up.
 */
export function filedFactsSkip(poll: PollOutcome, secRateLimited: boolean): string | null {
  if (poll.status === 'yielded') return `poll yielded to the ${poll.to}`
  if (poll.status === 'skipped') return `poll lock held by ${poll.heldBy}`
  if (secRateLimited) return 'SEC answered 429 earlier this tick'
  return null
}

type Filer = ReturnType<typeof readFiledFactSources>[number]

/** A fetch that answers null when it was deferred: SEC has answered 429 this run. */
type SecFetch = (source: FetchSource, read: ReadKey) => Promise<FetchOutcome | null>

type ReadKey = Pick<Read, 'ticker' | 'kind' | 'accession_no'>

interface Read {
  ticker: string
  kind: 'submissions' | 'companyfacts' | 'instance' | 'release' | 'text'
  accession_no: string | null
  status: 'ok' | 'unchanged' | 'failed'
  detail: string | null
  content_hash: string | null
  facts: number
  source_url: string
}

const submissionsUrl = (cik: string) => `https://data.sec.gov/submissions/CIK${cik}.json`

async function lastRead(db: PipelineDb, ticker: string, kind: string) {
  const [row] = await db
    .select()
    .from(tables.filedFactReads)
    .where(
      and(
        eq(tables.filedFactReads.ticker, ticker),
        eq(tables.filedFactReads.kind, kind),
        inArray(tables.filedFactReads.status, ['ok', 'unchanged']),
      ),
    )
    .orderBy(desc(tables.filedFactReads.started_at))
    .limit(1)
  return row ?? null
}

/** Insert the facts whose id is not stored yet; returns how many were new. */
async function storeFacts(
  db: PipelineDb,
  filer: Filer,
  facts: readonly FactInput[],
  prov: { basis: 'companyfacts' | 'instance'; raw_key: string; source_url: string; now: string },
): Promise<number> {
  const rows = facts.map((f) => ({
    id: contentHash({
      ticker: filer.ticker,
      concept: f.concept,
      dims: f.dims,
      start: f.start,
      end: f.end,
      accession_no: f.accession_no,
    }),
    ticker: filer.ticker,
    cik: filer.cik,
    ...f,
    basis: prov.basis,
    raw_key: prov.raw_key,
    first_seen_at: prov.now,
    source_url: prov.source_url,
    fetched_at: prov.now,
  }))
  const unique = [...new Map(rows.map((r) => [r.id, r])).values()]
  const stored = new Set<string>()
  for (const ids of chunk(
    unique.map((r) => r.id),
    D1_MAX_BOUND_PARAMS - 1,
  )) {
    const found = await db
      .select({ id: tables.filedFacts.id })
      .from(tables.filedFacts)
      .where(inArray(tables.filedFacts.id, ids))
    for (const r of found) stored.add(r.id)
  }
  const fresh = unique.filter((r) => !stored.has(r.id))
  await runStatements(
    db,
    chunk(fresh, Math.floor(D1_MAX_BOUND_PARAMS / FACT_COLUMNS)).map((part) =>
      db.insert(tables.filedFacts).values(part).onConflictDoNothing(),
    ),
  )
  return fresh.length
}

async function readCompanyfacts(
  db: PipelineDb,
  filer: Filer,
  fetchSec: SecFetch,
  deps: FiledFactsDeps,
  now: string,
): Promise<Read | null> {
  const base = { ticker: filer.ticker, kind: 'companyfacts' as const, accession_no: null }
  const fetched = await fetchSec(
    { source_id: `${filer.id}-companyfacts`, url: filer.url, ext: 'json' },
    base,
  )
  if (!fetched) return null
  if (!fetched.ok) {
    return {
      ...base,
      status: 'failed',
      detail: fetched.detail,
      content_hash: null,
      facts: 0,
      source_url: filer.url,
    }
  }
  const hash = contentHashOfText(fetched.text)
  if ((await lastRead(db, filer.ticker, 'companyfacts'))?.content_hash === hash) {
    return {
      ...base,
      status: 'unchanged',
      detail: null,
      content_hash: hash,
      facts: 0,
      source_url: filer.url,
    }
  }
  let facts: FactInput[]
  try {
    facts = extractCompanyfacts(fetched.text, filer.cik)
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      detail: `extract: ${String(error)}`,
      content_hash: null,
      facts: 0,
      source_url: filer.url,
    }
  }
  const raw_key = `filed-facts/${filer.ticker.toLowerCase()}/companyfacts-${hash}.json`
  await deps.raw.put(raw_key, fetched.text, 'application/json')
  const added = await storeFacts(db, filer, facts, {
    basis: 'companyfacts',
    raw_key,
    source_url: filer.url,
    now,
  })
  return {
    ...base,
    status: 'ok',
    detail: null,
    content_hash: hash,
    facts: added,
    source_url: filer.url,
  }
}

async function readInstance(
  db: PipelineDb,
  filer: Filer,
  doc: InstanceDocument,
  fetchSec: SecFetch,
  deps: FiledFactsDeps,
  now: string,
): Promise<Read | null> {
  const base = { ticker: filer.ticker, kind: 'instance' as const, accession_no: doc.accession_no }
  const fetched = await fetchSec(
    { source_id: `${filer.id}-${doc.accession_no}`, url: doc.url, ext: 'xml' },
    base,
  )
  if (!fetched) return null
  if (!fetched.ok) {
    return {
      ...base,
      status: 'failed',
      detail: fetched.detail,
      content_hash: null,
      facts: 0,
      source_url: doc.url,
    }
  }
  const members = Object.entries(LAB_MEMBERS)
    .filter(([, m]) => m.ticker === filer.ticker)
    .map(([member]) => member)
  let facts: FactInput[]
  try {
    facts = extractInstanceFacts(fetched.text, { cik: filer.cik, ...doc }, members)
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      detail: `extract: ${String(error)}`,
      content_hash: null,
      facts: 0,
      source_url: doc.url,
    }
  }
  const hash = contentHashOfText(fetched.text)
  const raw_key = `filed-facts/${filer.ticker.toLowerCase()}/${doc.accession_no}.xml`
  if (facts.length) await deps.raw.put(raw_key, fetched.text, 'application/xml')
  const added = await storeFacts(db, filer, facts, {
    basis: 'instance',
    raw_key,
    source_url: doc.url,
    now,
  })
  return {
    ...base,
    status: 'ok',
    detail: null,
    content_hash: hash,
    facts: added,
    source_url: doc.url,
  }
}

/** Store the guidance one release prints; returns how many rows were new. */
async function storeGuidance(
  db: PipelineDb,
  filer: Filer,
  doc: ReleaseDocument,
  found: readonly GuidanceInput[],
  prov: { raw_key: string; source_url: string; now: string },
): Promise<number> {
  let added = 0
  for (const g of found) {
    const written = await db
      .insert(tables.filedGuidance)
      .values({
        id: contentHash({
          ticker: filer.ticker,
          accession_no: doc.accession_no,
          fiscal_year: g.fiscal_year,
        }),
        ticker: filer.ticker,
        cik: filer.cik,
        accession_no: doc.accession_no,
        filed: doc.filed,
        ...g,
        raw_key: prov.raw_key,
        first_seen_at: prov.now,
        source_url: prov.source_url,
        fetched_at: prov.now,
      })
      .onConflictDoNothing()
      .returning({ id: tables.filedGuidance.id })
    added += written.length
  }
  return added
}

/** One earnings release: the filing's index page for its exhibit 99.1, then the exhibit. */
async function readRelease(
  db: PipelineDb,
  filer: Filer,
  doc: ReleaseDocument,
  fetchSec: SecFetch,
  deps: FiledFactsDeps,
  now: string,
): Promise<Read | null> {
  const base = { ticker: filer.ticker, kind: 'release' as const, accession_no: doc.accession_no }
  const failed = (detail: string, source_url: string): Read => ({
    ...base,
    status: 'failed',
    detail,
    content_hash: null,
    facts: 0,
    source_url,
  })
  const index = await fetchSec(
    { source_id: `${filer.id}-${doc.accession_no}-index`, url: doc.index_url, ext: 'html' },
    base,
  )
  if (!index) return null
  if (!index.ok) return failed(index.detail, doc.index_url)
  let url: string | null
  try {
    url = exhibitUrl(index.text, filer.cik, doc.accession_no)
  } catch (error) {
    return failed(`index: ${String(error)}`, doc.index_url)
  }
  if (!url) {
    return {
      ...base,
      status: 'ok',
      detail: 'no exhibit 99.1',
      content_hash: null,
      facts: 0,
      source_url: doc.index_url,
    }
  }
  const fetched = await fetchSec(
    { source_id: `${filer.id}-${doc.accession_no}-release`, url, ext: 'html' },
    base,
  )
  if (!fetched) return null
  if (!fetched.ok) return failed(fetched.detail, url)
  const found = extractGuidance(fetched.text)
  const raw_key = `guidance/${filer.ticker.toLowerCase()}/${doc.accession_no}.htm`
  if (found.length) await deps.raw.put(raw_key, fetched.text, 'text/html')
  const added = await storeGuidance(db, filer, doc, found, { raw_key, source_url: url, now })
  return {
    ...base,
    status: 'ok',
    detail: null,
    content_hash: contentHashOfText(fetched.text),
    facts: added,
    source_url: url,
  }
}

/** A 10-Q or 10-K's primary document: what its instance URL names, as .htm. */
export const primaryUrl = (doc: InstanceDocument) => doc.url.replace(/_htm\.xml$/, '.htm')

/** Store one filing's text facts; returns how many were new. */
async function storeTextFacts(
  db: PipelineDb,
  filer: Filer,
  doc: InstanceDocument,
  lab: string,
  facts: readonly TextFact[],
  prov: { raw_key: string; source_url: string; now: string },
): Promise<number> {
  const rows = facts.map((f) => ({
    id: contentHash({
      ticker: filer.ticker,
      metric: f.metric,
      start: f.start,
      end: f.end,
      accession_no: doc.accession_no,
    }),
    ticker: filer.ticker,
    cik: filer.cik,
    lab,
    metric: f.metric,
    start: f.start,
    end: f.end,
    value: f.value,
    unit: 'USD',
    qualifier: f.qualifier,
    sentence: f.sentence,
    form: doc.form,
    filed: doc.filed,
    accession_no: doc.accession_no,
    raw_key: prov.raw_key,
    first_seen_at: prov.now,
    source_url: prov.source_url,
    fetched_at: prov.now,
  }))
  let added = 0
  for (const part of chunk(rows, Math.floor(D1_MAX_BOUND_PARAMS / TEXT_FACT_COLUMNS))) {
    const written = await db
      .insert(tables.filedTextFacts)
      .values(part)
      .onConflictDoNothing()
      .returning({ id: tables.filedTextFacts.id })
    added += written.length
  }
  return added
}

const TEXT_FACT_COLUMNS = 19

/** One 10-Q or 10-K's primary document, for the figures it states about a lab in words. */
async function readText(
  db: PipelineDb,
  filer: Filer,
  doc: InstanceDocument,
  fetchSec: SecFetch,
  deps: FiledFactsDeps,
  now: string,
): Promise<Read | null> {
  const spec = TEXT_FACT_FILERS[filer.ticker]!
  const url = primaryUrl(doc)
  const base = { ticker: filer.ticker, kind: 'text' as const, accession_no: doc.accession_no }
  const fetched = await fetchSec(
    { source_id: `${filer.id}-${doc.accession_no}-text`, url, ext: 'html' },
    base,
  )
  if (!fetched) return null
  if (!fetched.ok) {
    return {
      ...base,
      status: 'failed',
      detail: fetched.detail,
      content_hash: null,
      facts: 0,
      source_url: url,
    }
  }
  let facts: TextFact[]
  try {
    facts = extractTextFacts(fetched.text, spec.name)
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      detail: `extract: ${String(error)}`,
      content_hash: null,
      facts: 0,
      source_url: url,
    }
  }
  const raw_key = `filed-facts/${filer.ticker.toLowerCase()}/${doc.accession_no}.htm`
  if (facts.length) await deps.raw.put(raw_key, fetched.text, 'text/html')
  const added = await storeTextFacts(db, filer, doc, spec.lab, facts, {
    raw_key,
    source_url: url,
    now,
  })
  return {
    ...base,
    status: 'ok',
    detail: facts.length ? null : 'no figure about the lab in a wording the reader knows',
    content_hash: contentHashOfText(fetched.text),
    facts: added,
    source_url: url,
  }
}

/**
 * Accessions with an ok read of `kind`, and those that failed within
 * FAILED_RETRY_MS. A 429 is not the document failing: it waits out the
 * cooldown with the rest of the run instead.
 */
async function documentState(
  db: PipelineDb,
  ticker: string,
  kind: 'instance' | 'release' | 'text',
  now: Date,
) {
  const rows = await db
    .select({
      accession_no: tables.filedFactReads.accession_no,
      status: tables.filedFactReads.status,
      detail: tables.filedFactReads.detail,
      started_at: tables.filedFactReads.started_at,
    })
    .from(tables.filedFactReads)
    .where(and(eq(tables.filedFactReads.ticker, ticker), eq(tables.filedFactReads.kind, kind)))
  const retryFrom = new Date(now.getTime() - FAILED_RETRY_MS).toISOString()
  const done = new Set<string>()
  const failedRecently = new Set<string>()
  for (const r of rows) {
    if (!r.accession_no) continue
    if (r.status === 'ok') done.add(r.accession_no)
    else if (r.started_at >= retryFrom && !isRateLimitRun(r)) failedRecently.add(r.accession_no)
  }
  return { done, failedRecently }
}

/** True when a filing from the last FRESH_DAYS has no company-facts fact yet. */
async function companyfactsBehind(
  db: PipelineDb,
  ticker: string,
  docs: readonly InstanceDocument[],
  now: Date,
): Promise<boolean> {
  const freshFrom = new Date(now.getTime() - FRESH_DAYS * 86_400_000).toISOString().slice(0, 10)
  const fresh = docs.filter((d) => d.filed >= freshFrom).map((d) => d.accession_no)
  if (fresh.length === 0) return false
  const rows = await db
    .selectDistinct({ accession_no: tables.filedFacts.accession_no })
    .from(tables.filedFacts)
    .where(
      and(
        eq(tables.filedFacts.ticker, ticker),
        eq(tables.filedFacts.basis, 'companyfacts'),
        inArray(tables.filedFacts.accession_no, fresh),
      ),
    )
  return rows.length < fresh.length
}

/** Every stored fact for one filer, as the series read them. */
export async function filerFacts(db: PipelineDb, ticker: string): Promise<StoredFact[]> {
  return db
    .select({
      ticker: tables.filedFacts.ticker,
      concept: tables.filedFacts.concept,
      dims: tables.filedFacts.dims,
      start: tables.filedFacts.start,
      end: tables.filedFacts.end,
      value: tables.filedFacts.value,
      unit: tables.filedFacts.unit,
      form: tables.filedFacts.form,
      filed: tables.filedFacts.filed,
      accession_no: tables.filedFacts.accession_no,
      cik: tables.filedFacts.cik,
      source_url: tables.filedFacts.source_url,
      fetched_at: tables.filedFacts.fetched_at,
    })
    .from(tables.filedFacts)
    .where(eq(tables.filedFacts.ticker, ticker))
}

async function writeAlerts(db: PipelineDb, filer: Filer, now: Date): Promise<number> {
  const [first] = await db
    .select({ at: min(tables.filedFactReads.started_at) })
    .from(tables.filedFactReads)
    .where(eq(tables.filedFactReads.ticker, filer.ticker))
  if (!first?.at) return 0
  const facts = await filerFacts(db, filer.ticker)
  const earlier = earlierPoints(facts)
  const out = buildSeries(facts)
    .filter(isAlerting)
    .map((s) => filedFactAlert(s, { now, firstReadAt: first.at!, cik: filer.cik, earlier }))
    .filter((a) => a !== null)
  if (out.length === 0) return 0
  const known = new Set(
    (
      await db
        .select({ id: tables.alerts.id })
        .from(tables.alerts)
        .where(
          inArray(
            tables.alerts.id,
            out.map((a) => a.alert.id),
          ),
        )
    ).map((r) => r.id),
  )
  const fresh = out.filter((a) => !known.has(a.alert.id))
  for (const { change, alert } of fresh) {
    await db.insert(tables.changes).values(change).onConflictDoNothing()
    await db.insert(tables.alerts).values(alert).onConflictDoNothing()
  }
  return fresh.length
}

async function writeFilerGuidanceAlerts(
  db: PipelineDb,
  filer: Filer,
  deps: FiledFactsDeps,
): Promise<number> {
  const first = async (kind?: string) => {
    const [row] = await db
      .select({ at: min(tables.filedFactReads.started_at) })
      .from(tables.filedFactReads)
      .where(
        and(
          eq(tables.filedFactReads.ticker, filer.ticker),
          kind ? eq(tables.filedFactReads.kind, kind) : undefined,
        ),
      )
    return row?.at ?? null
  }
  const [guidance, facts, firstReadAt, firstReleaseReadAt] = await Promise.all([
    db
      .select()
      .from(tables.filedGuidance)
      .where(
        and(
          eq(tables.filedGuidance.ticker, filer.ticker),
          eq(tables.filedGuidance.source, 'release'),
        ),
      ),
    filerFacts(db, filer.ticker),
    first(),
    first('release'),
  ])
  return writeGuidanceAlerts(db, filer, guidance, facts, deps.readRaw, {
    now: deps.now,
    firstReadAt,
    firstReleaseReadAt,
  })
}

export async function runFiledFacts(
  db: PipelineDb,
  deps: FiledFactsDeps,
): Promise<FiledFactsReport> {
  const now = deps.now.toISOString()
  const coolingUntil = await cooldownUntil(db, deps.now)
  if (coolingUntil) return { reads: [], alerts: 0, deferred: 0, cooling_until: coolingUntil }

  const filers = readFiledFactSources(deps.sourcesYaml, parseCikWhitelistBlock(deps.sourcesYaml))
  const reads: Read[] = []
  const queue: { filer: Filer; docs: InstanceDocument[] }[] = []
  const releases: { filer: Filer; docs: ReleaseDocument[] }[] = []
  const texts: { filer: Filer; docs: InstanceDocument[] }[] = []

  // After the first 429 nothing else is fetched; each request the run would
  // still have made is counted instead.
  let throttled: Read | null = null
  let deferred = 0
  const fetchSec: SecFetch = async (source, read) => {
    if (throttled) {
      deferred++
      return null
    }
    const outcome = await deps.fetcher(source)
    if (outcome.ok || outcome.status !== 429) return outcome
    deferred++
    throttled = {
      ...read,
      status: 'failed',
      detail: outcome.detail,
      content_hash: null,
      facts: 0,
      source_url: source.url,
    }
    return null
  }

  for (const filer of filers) {
    const url = submissionsUrl(filer.cik)
    const sub = await fetchSec(
      { source_id: `${filer.id}-submissions`, url, ext: 'json' },
      { ticker: filer.ticker, kind: 'submissions', accession_no: null },
    )
    // A deferred submissions feed (null) leaves no list to work from this run.
    let docs: InstanceDocument[] = []
    let filed: ReleaseDocument[] = []
    if (sub && !sub.ok) {
      reads.push({
        ticker: filer.ticker,
        kind: 'submissions',
        accession_no: null,
        status: 'failed',
        detail: sub.detail,
        content_hash: null,
        facts: 0,
        source_url: url,
      })
    } else if (sub) {
      try {
        docs = instanceDocuments(sub.text, filer.cik, SERIES_SINCE)
        filed = releaseDocuments(sub.text, filer.cik, GUIDANCE_SINCE)
      } catch (error) {
        reads.push({
          ticker: filer.ticker,
          kind: 'submissions',
          accession_no: null,
          status: 'failed',
          detail: `parse: ${String(error)}`,
          content_hash: null,
          facts: 0,
          source_url: url,
        })
      }
    }

    const last = await lastRead(db, filer.ticker, 'companyfacts')
    const due =
      !last ||
      deps.now.getTime() - Date.parse(last.started_at) >= COMPANYFACTS_INTERVAL_MS ||
      (await companyfactsBehind(db, filer.ticker, docs, deps.now))
    if (due) {
      const read = await readCompanyfacts(db, filer, fetchSec, deps, now)
      if (read) reads.push(read)
    }

    if (filer.instances && docs.length) {
      const { done, failedRecently } = await documentState(db, filer.ticker, 'instance', deps.now)
      queue.push({
        filer,
        docs: docs.filter((d) => !done.has(d.accession_no) && !failedRecently.has(d.accession_no)),
      })
    }
    const textSpec = TEXT_FACT_FILERS[filer.ticker]
    const textDocs = textSpec
      ? docs.filter((d) => d.filed >= textSpec.since && d.filed < textSpec.until)
      : []
    if (textDocs.length) {
      const { done, failedRecently } = await documentState(db, filer.ticker, 'text', deps.now)
      texts.push({
        filer,
        docs: textDocs
          .filter((d) => !done.has(d.accession_no) && !failedRecently.has(d.accession_no))
          // Oldest first: the series fills from its start.
          .reverse(),
      })
    }
    if (filed.length) {
      const { done, failedRecently } = await documentState(db, filer.ticker, 'release', deps.now)
      releases.push({
        filer,
        docs: filed.filter((d) => !done.has(d.accession_no) && !failedRecently.has(d.accession_no)),
      })
    }
  }

  // Newest first within a filer, one filer at a time in turn, so a back-fill
  // never starves the filing that was just made.
  for (let budget = INSTANCES_PER_RUN; budget > 0 && queue.some((q) => q.docs.length);) {
    for (const q of queue) {
      const doc = q.docs.shift()
      if (!doc || budget === 0) continue
      budget--
      const read = await readInstance(db, q.filer, doc, fetchSec, deps, now)
      if (read) reads.push(read)
    }
  }

  // After the instances, so a new 10-Q is never held up by a release back-fill.
  for (let budget = RELEASES_PER_RUN; budget > 0 && releases.some((q) => q.docs.length);) {
    for (const q of releases) {
      const doc = q.docs.shift()
      if (!doc || budget === 0) continue
      budget--
      const read = await readRelease(db, q.filer, doc, fetchSec, deps, now)
      if (read) reads.push(read)
    }
  }

  // Last: a closed window of old filings, read a few a run until it is done.
  for (let budget = TEXTS_PER_RUN; budget > 0 && texts.some((q) => q.docs.length);) {
    for (const q of texts) {
      const doc = q.docs.shift()
      if (!doc || budget === 0) continue
      budget--
      const read = await readText(db, q.filer, doc, fetchSec, deps, now)
      if (read) reads.push(read)
    }
  }

  // The 429 is stored with the reads: it is what the next runs' cooldown keys on.
  const limited = throttled as Read | null
  await runStatements(
    db,
    [...reads, ...(limited ? [limited] : [])].map((r) =>
      db.insert(tables.filedFactReads).values({ id: crypto.randomUUID(), ...r, started_at: now }),
    ),
  )
  for (const r of reads.filter((x) => x.status === 'failed')) {
    // An instance failure retries a day later; say so once, not every run.
    await recordOpsEvent(db, {
      kind: 'filed_facts_failed',
      detail: `${readName(r)}: ${r.detail}`,
    })
  }
  if (limited) {
    const until = cooldownEndsAt({ ...limited, started_at: now })
    await recordOpsEvent(db, {
      kind: 'filed_facts_deferred',
      detail:
        `filed facts: ${deferred} requests deferred after SEC 429 on ${readName(limited)}` +
        ` (${limited.detail}); next read after ${new Date(until!).toISOString()}`,
    })
  }

  let alerts = 0
  for (const filer of filers) {
    const gained = (release: boolean) =>
      reads.some(
        (r) => r.ticker === filer.ticker && (r.kind === 'release') === release && r.facts > 0,
      )
    // A release's rows are guidance, which no series reads.
    if (gained(false)) alerts += await writeAlerts(db, filer, deps.now)
    if (gained(false) || gained(true)) alerts += await writeFilerGuidanceAlerts(db, filer, deps)
  }
  return {
    reads: reads.map(({ ticker, kind, accession_no, status, facts }) => ({
      ticker,
      kind,
      accession_no,
      status,
      facts,
    })),
    alerts,
    deferred,
    cooling_until: null,
  }
}

const readName = (r: ReadKey) =>
  `${r.ticker} ${r.kind}${r.accession_no ? ` ${r.accession_no}` : ''}`

/** When the newest SEC 429 still holds the reader off, the time it lifts (ISO); else null. */
async function cooldownUntil(db: PipelineDb, now: Date): Promise<string | null> {
  const [last] = await db
    .select({
      status: tables.filedFactReads.status,
      detail: tables.filedFactReads.detail,
      started_at: tables.filedFactReads.started_at,
    })
    .from(tables.filedFactReads)
    .where(
      and(
        eq(tables.filedFactReads.status, 'failed'),
        like(tables.filedFactReads.detail, `${RATE_LIMITED_DETAIL}%`),
      ),
    )
    .orderBy(desc(tables.filedFactReads.started_at))
    .limit(1)
  const until = cooldownEndsAt(last)
  return until !== null && now.getTime() < until ? new Date(until).toISOString() : null
}

/** The newest read per filer and how many instances it has read: the coverage the page states. */
export async function readState(db: PipelineDb, at: string | null) {
  const rows = await db
    .select({
      ticker: tables.filedFactReads.ticker,
      kind: tables.filedFactReads.kind,
      status: tables.filedFactReads.status,
      started_at: tables.filedFactReads.started_at,
    })
    .from(tables.filedFactReads)
  const out = new Map<string, { last_read_at: string | null; instances_read: number }>()
  for (const r of rows) {
    if (at && r.started_at > at) continue
    const s = out.get(r.ticker) ?? { last_read_at: null, instances_read: 0 }
    if (r.status !== 'failed' && (!s.last_read_at || r.started_at > s.last_read_at)) {
      s.last_read_at = r.started_at
    }
    if (r.kind === 'instance' && r.status === 'ok') s.instances_read++
    out.set(r.ticker, s)
  }
  return out
}
