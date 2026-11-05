// Detection latency for SEC filings: for each filing a rule alert cites, when
// EDGAR accepted it and when we alerted. The acceptance time is read back from
// bytes the poll already stored in R2: the filer's submissions JSON
// (acceptanceDateTime, UTC) or, for a filer without one yet, the filing's
// index page ("Accepted", Eastern time). No new SEC fetch, so the history goes
// back as far as the stored payloads do, and a filing that no stored payload
// lists is recorded as missing rather than guessed.

import { and, eq, gte, inArray, like, max, or } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { DETECTION_RULES, EDGAR_RELEASE_HOUR_ET } from '../../../shared/utils/terminal-reliability'
import { cellText } from '../parsers/sec/filing-index'
import { D1_MAX_BOUND_PARAMS, chunk, type PipelineDb } from '../store'

const ACCESSION = /^\d{10}-\d{2}-\d{6}$/
const HOUR_MS = 3_600_000
const OVERLAP_MS = 30 * 24 * HOUR_MS

/** How long a filing no stored payload lists is looked for again: the next poll derives its filer's feeds. */
export const MISSING_RETRY_HOURS = 48
/** Filings resolved per run; each costs at most one R2 read per filer. */
export const MAX_RESOLVES_PER_RUN = 25

export interface CitedFiling {
  accession_no: string
  cik: string
  form: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** The filing a cited change row is about: a filing, a lab's resolved filer, or a prospectus row. */
export function citedFiling(change: {
  entity_key: string
  after_json: string | null
  before_json: string | null
}): CitedFiling | null {
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(change.after_json ?? change.before_json ?? '{}') as Record<string, unknown>
  } catch {
    return null
  }
  const accession =
    str(payload.accession_no) ??
    str(payload.resolved_accession) ??
    change.entity_key.match(/^(?:filing|document|offering):(.+)$/)?.[1] ??
    null
  const ciks = Array.isArray(payload.ciks) ? payload.ciks : []
  const cik = str(payload.whitelist_cik) ?? str(payload.cik) ?? str(ciks[0])
  if (!accession || !ACCESSION.test(accession) || !cik || !/^\d{1,10}$/.test(cik)) return null
  return {
    accession_no: accession,
    cik: cik.padStart(10, '0'),
    form: str(payload.form) ?? str(payload.resolved_form),
  }
}

export interface Acceptance {
  accepted_at: string
  filing_date: string | null
  form: string | null
}

/** One filing's acceptance time from a data.sec.gov submissions payload, or null when it isn't listed. */
export function acceptanceFromSubmissions(text: string, accession: string): Acceptance | null {
  const doc = JSON.parse(text) as {
    filings?: {
      recent?: {
        accessionNumber?: string[]
        acceptanceDateTime?: string[]
        filingDate?: string[]
        form?: string[]
      }
    }
  }
  const recent = doc.filings?.recent
  const i = recent?.accessionNumber?.indexOf(accession) ?? -1
  const at = i >= 0 ? recent?.acceptanceDateTime?.[i] : undefined
  if (!at || Number.isNaN(Date.parse(at))) return null
  return {
    accepted_at: new Date(at).toISOString(),
    filing_date: recent?.filingDate?.[i] ?? null,
    form: recent?.form?.[i] ?? null,
  }
}

/** UTC offset of America/New_York at `utcMs`, in milliseconds (negative). */
function easternOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
  return wall - Math.floor(utcMs / 1000) * 1000
}

/** An Eastern wall-clock time (`YYYY-MM-DD`, `HH:MM:SS`) as a UTC ISO instant, daylight saving included. */
export function easternToUtc(day: string, time: string): string {
  const wall = Date.parse(`${day}T${time}.000Z`)
  // The offset at the guess is right except within an hour of a clock change;
  // a second pass with the corrected instant settles it.
  let utc = wall - easternOffsetMs(wall)
  utc = wall - easternOffsetMs(utc)
  return new Date(utc).toISOString()
}

/** The "Filing Date" and "Accepted" fields of an EDGAR filing index page. */
export function acceptanceFromFilingIndex(html: string): Acceptance | null {
  const field = (head: string) =>
    cellText(
      html.match(
        new RegExp(`<div class="infoHead">${head}</div>\\s*<div class="info">([^<]*)</div>`, 'i'),
      )?.[1] ?? '',
    )
  const accepted = field('Accepted').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/)
  if (!accepted) return null
  const filed = field('Filing Date')
  return {
    accepted_at: easternToUtc(accepted[1]!, accepted[2]!),
    filing_date: /^\d{4}-\d{2}-\d{2}$/.test(filed) ? filed : null,
    form: null,
  }
}

/**
 * When EDGAR made the filing public. A filing accepted after 5:30 p.m.
 * Eastern gets the next business day as its filing date and is released at
 * 6:00 a.m. Eastern that day, so the later of the acceptance time and 6:00
 * a.m. on the filing date.
 */
export function releasedAt(acceptedAt: string, filingDate: string | null): string {
  if (!filingDate) return acceptedAt
  const opens = easternToUtc(filingDate, `${String(EDGAR_RELEASE_HOUR_ET).padStart(2, '0')}:00:00`)
  return opens > acceptedAt ? opens : acceptedAt
}

/** The filing's index page on EDGAR. */
export function filingIndexUrl(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${accession}-index.htm`
}

/** Stored bytes by R2 key; null when the object is gone. */
export interface RawReader {
  get(key: string): Promise<string | null>
}

interface StoredPayload {
  snapshot_id: string
  raw_key: string
  source_url: string
  fetched_at: string
}

export interface DetectionReport {
  alerts: number
  resolved: number
  found: number
  missing: number
}

/** The first rule alert per filing, from alerts not yet recorded (or still missing), up to MAX_RESOLVES_PER_RUN. */
async function pendingFilings(db: PipelineDb, now: Date) {
  const [newest] = await db
    .select({ at: max(tables.filingDetections.alerted_at) })
    .from(tables.filingDetections)
  // Rule alerts are written in the tick that saw the filing, so a month of
  // overlap with the newest recorded one is plenty; the first run reads them all.
  const since = newest?.at ? new Date(Date.parse(newest.at) - OVERLAP_MS).toISOString() : ''
  const [recorded, alerts] = await Promise.all([
    db
      .select({
        accession_no: tables.filingDetections.accession_no,
        status: tables.filingDetections.status,
        alerted_at: tables.filingDetections.alerted_at,
      })
      .from(tables.filingDetections)
      .where(
        or(
          eq(tables.filingDetections.status, 'missing'),
          gte(tables.filingDetections.alerted_at, since),
        ),
      ),
    db
      .select({
        id: tables.alerts.id,
        rule: tables.alerts.rule,
        headline: tables.alerts.headline,
        created_at: tables.alerts.created_at,
        change_ids: tables.alerts.change_ids,
      })
      .from(tables.alerts)
      .where(
        and(
          gte(tables.alerts.created_at, since),
          inArray(tables.alerts.rule, [...DETECTION_RULES]),
        ),
      ),
  ])
  const changeIds = [...new Set(alerts.flatMap((a) => JSON.parse(a.change_ids) as string[]))]
  const changes = []
  for (const group of chunk(changeIds, D1_MAX_BOUND_PARAMS - 5)) {
    changes.push(
      ...(await db
        .select({
          id: tables.changes.id,
          entity_key: tables.changes.entity_key,
          after_json: tables.changes.after_json,
          before_json: tables.changes.before_json,
        })
        .from(tables.changes)
        .where(inArray(tables.changes.id, group))),
    )
  }
  const changeById = new Map(changes.map((c) => [c.id, c]))

  const first = new Map<
    string,
    CitedFiling & { alert_id: string; rule: string; headline: string; alerted_at: string }
  >()
  for (const alert of alerts) {
    for (const id of JSON.parse(alert.change_ids) as string[]) {
      const change = changeById.get(id)
      const filing = change ? citedFiling(change) : null
      if (!filing) continue
      const prev = first.get(filing.accession_no)
      if (prev && prev.alerted_at <= alert.created_at) continue
      first.set(filing.accession_no, {
        ...filing,
        form: filing.form ?? prev?.form ?? null,
        alert_id: alert.id,
        rule: alert.rule,
        headline: alert.headline,
        alerted_at: alert.created_at,
      })
    }
  }
  const known = new Map(recorded.map((r) => [r.accession_no, r]))
  const retryFrom = new Date(now.getTime() - MISSING_RETRY_HOURS * HOUR_MS).toISOString()
  return {
    alerts: alerts.length,
    pending: [...first.values()]
      .filter((f) => {
        const row = known.get(f.accession_no)
        if (!row) return true
        // An earlier alert for a recorded filing replaces the one on file.
        if (f.alerted_at < row.alerted_at) return true
        return row.status === 'missing' && f.alerted_at >= retryFrom
      })
      .sort((a, b) => a.alerted_at.localeCompare(b.alerted_at))
      .slice(0, MAX_RESOLVES_PER_RUN),
  }
}

/** Newest stored snapshot of each submissions feed, by the CIK in its URL. */
async function submissionsByCik(db: PipelineDb): Promise<Map<string, StoredPayload>> {
  const rows = await db
    .select({
      snapshot_id: tables.snapshots.id,
      raw_key: tables.snapshots.raw_key,
      source_url: tables.snapshots.source_url,
      fetched_at: tables.snapshots.fetched_at,
    })
    .from(tables.sourceStats)
    .crossJoin(tables.snapshots)
    .where(
      and(
        like(tables.sourceStats.source_id, 'edgar-submissions-%'),
        eq(tables.snapshots.source_id, tables.sourceStats.source_id),
        eq(tables.snapshots.fetched_at, tables.sourceStats.last_fetched_at),
      ),
    )
  const out = new Map<string, StoredPayload>()
  for (const row of rows) {
    const cik = row.source_url.match(/CIK(\d{10})\.json$/)?.[1]
    if (cik) out.set(cik, row)
  }
  return out
}

/** Newest stored snapshot of the filing's own index page, if the poll derived one for it. */
async function filingIndexSnapshot(
  db: PipelineDb,
  accession: string,
): Promise<StoredPayload | null> {
  const [row] = await db
    .select({
      snapshot_id: tables.snapshots.id,
      raw_key: tables.snapshots.raw_key,
      source_url: tables.snapshots.source_url,
      fetched_at: tables.snapshots.fetched_at,
    })
    .from(tables.sourceStats)
    .crossJoin(tables.snapshots)
    .where(
      and(
        like(tables.sourceStats.source_id, `filing-index-%-${accession}`),
        eq(tables.snapshots.source_id, tables.sourceStats.source_id),
        eq(tables.snapshots.fetched_at, tables.sourceStats.last_fetched_at),
      ),
    )
    .limit(1)
  return row ?? null
}

/** Record the first rule alert and EDGAR's acceptance time for each filing not yet on file. */
export async function recordDetections(
  db: PipelineDb,
  deps: { raw: RawReader; now: Date },
): Promise<DetectionReport> {
  const { alerts, pending } = await pendingFilings(db, deps.now)
  const report: DetectionReport = { alerts, resolved: 0, found: 0, missing: 0 }
  if (pending.length === 0) return report

  const feeds = await submissionsByCik(db)
  // One R2 read and parse per filer per run, however many of its filings are pending.
  const parsed = new Map<string, string | null>()
  const read = async (payload: StoredPayload) => {
    if (!parsed.has(payload.raw_key))
      parsed.set(payload.raw_key, await deps.raw.get(payload.raw_key))
    return parsed.get(payload.raw_key) ?? null
  }

  for (const filing of pending) {
    let found: (Acceptance & { basis: string; payload: StoredPayload }) | null = null
    const feed = feeds.get(filing.cik)
    if (feed) {
      const text = await read(feed)
      const hit = text ? acceptanceFromSubmissions(text, filing.accession_no) : null
      if (hit) found = { ...hit, basis: 'submissions', payload: feed }
    }
    if (!found) {
      const index = await filingIndexSnapshot(db, filing.accession_no)
      const html = index ? await read(index) : null
      const hit = html ? acceptanceFromFilingIndex(html) : null
      if (hit && index) found = { ...hit, basis: 'filing-index', payload: index }
    }
    const row = {
      accession_no: filing.accession_no,
      cik: filing.cik,
      form: found?.form ?? filing.form,
      alert_id: filing.alert_id,
      rule: filing.rule,
      headline: filing.headline,
      alerted_at: filing.alerted_at,
      status: found ? 'found' : 'missing',
      accepted_at: found?.accepted_at ?? null,
      filing_date: found?.filing_date ?? null,
      basis: found?.basis ?? null,
      snapshot_id: found?.payload.snapshot_id ?? null,
      source_url: found?.payload.source_url ?? null,
      fetched_at: found?.payload.fetched_at ?? null,
      recorded_at: deps.now.toISOString(),
    }
    const set: Partial<typeof row> = { ...row }
    delete set.accession_no
    await db
      .insert(tables.filingDetections)
      .values(row)
      .onConflictDoUpdate({ target: tables.filingDetections.accession_no, set })
    report.resolved++
    if (found) report.found++
    else report.missing++
  }
  return report
}
