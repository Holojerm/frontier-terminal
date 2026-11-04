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
//      again: a filing does not change after it is accepted.
//
// Facts are append-only (filed_facts). The raw bytes of every document that
// produced facts go to R2 first, so each row's raw_key resolves. Then the
// filed-fact rule (alerts.ts) runs over each filer that gained facts.
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
import { LAB_MEMBERS, SERIES_SINCE, buildSeries, isAlerting, type StoredFact } from './series'

export const INSTANCES_PER_RUN = 24
export const COMPANYFACTS_INTERVAL_MS = 6 * 60 * 60 * 1000
/** A failed instance is retried after this long, not every run. */
export const FAILED_RETRY_MS = 24 * 60 * 60 * 1000

const FACT_COLUMNS = 17

export interface FiledFactsDeps {
  raw: RawStore
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
  kind: 'submissions' | 'companyfacts' | 'instance'
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

/**
 * Accessions with an ok instance read, and those that failed within
 * FAILED_RETRY_MS. A 429 is not the document failing: it waits out the
 * cooldown with the rest of the run instead.
 */
async function instanceState(db: PipelineDb, ticker: string, now: Date) {
  const rows = await db
    .select({
      accession_no: tables.filedFactReads.accession_no,
      status: tables.filedFactReads.status,
      detail: tables.filedFactReads.detail,
      started_at: tables.filedFactReads.started_at,
    })
    .from(tables.filedFactReads)
    .where(
      and(eq(tables.filedFactReads.ticker, ticker), eq(tables.filedFactReads.kind, 'instance')),
    )
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
  const out = buildSeries(await filerFacts(db, filer.ticker))
    .filter(isAlerting)
    .map((s) => filedFactAlert(s, { now, firstReadAt: first.at!, cik: filer.cik }))
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
      const { done, failedRecently } = await instanceState(db, filer.ticker, deps.now)
      queue.push({
        filer,
        docs: docs.filter((d) => !done.has(d.accession_no) && !failedRecently.has(d.accession_no)),
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
    if (reads.some((r) => r.ticker === filer.ticker && r.facts > 0)) {
      alerts += await writeAlerts(db, filer, deps.now)
    }
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
