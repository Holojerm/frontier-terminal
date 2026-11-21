// The judge's reading of an SEC document that names a lab site. GET
// /api/judge/pending offers each document the reader stored and found power
// spoken of near the site's name in (ingest.ts) as a POWER SITE REVIEW entry:
// excerpts of its text, the site as Epoch has it, and the ties the table
// already holds for that site. The judge sends back, per document, the
// companies the document ties to the site's power, or none.
//
// The model only finds the sentence and says what it states. The Worker
// decides, against the document as R2 holds it:
//   1. the document was offered for that site and is not settled yet;
//   2. the quote is in the document verbatim (see contains);
//   3. the quote names the company and the site, by a name it was searched for;
//   4. the quote says something of the kind the role claims (ROLE_CUES);
//   5. a megawatt figure is written in the quote, in MW or GW;
//   6. the ticker, parent, title, publisher, dates and provenance are set
//      here, never by the model: a company is matched to a listing only when
//      the hand-read table already lists it, or it is the filer itself.
// A tie that fails is dropped, with an ops event. Once a document is answered
// it is settled: rows of its filer and periodic form it no longer repeats
// have ended.

import { z } from 'zod'

import { curatedPowerSites, POWER_ROLES } from '../../shared/utils/power-sites'
import curated from '../curated/power-sites.json'
import type { RawReader } from '#layers/core/server/pipeline/raw'
import { contains, documentText } from '#layers/core/server/pipeline/document-text'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import { comparable } from '#layers/core/server/utils/quote-match'
import { mwWritten, powerExcerpts, roleStated, siteNamed } from './excerpts'
import { documentRef, filerOf, pendingDocuments } from './ingest'
import { epochLabSites } from './sites'
import { currentTies, insertTies, settleDocument, tieId } from './store'

/** Documents offered per judge run, oldest filing first. */
export const POWER_SITE_REVIEW_LIMIT = 4

const JudgePowerTie = z.strictObject({
  role: z.enum(POWER_ROLES),
  company: z.string().min(1).max(120),
  mw: z.number().positive().nullable(),
  mw_meaning: z.string().min(1).max(200).nullable(),
  quote: z.string().min(20).max(400),
})

export const JudgePowerSiteReading = z.strictObject({
  document_id: z.string().min(1).max(120),
  site: z.string().min(1).max(120),
  ties: JudgePowerTie.array().max(12),
})
export type JudgePowerSiteReading = z.infer<typeof JudgePowerSiteReading>
type Tie = z.infer<typeof JudgePowerTie>

export interface PowerSiteReview {
  document_id: string
  /** Epoch's name for the site, to send back with the reading. */
  site: string
  /** The names the document was found by: a tie's quote must use one. */
  site_names: string[]
  /** Epoch's labs, owner and users for the site, verbatim. */
  labs: string[]
  owner: string | null
  users: string | null
  filer: string
  form: string
  file_type: string
  filed: string
  /** The ties the table holds for this site now: send a tie only if it is not one of these. */
  known: {
    role: string
    company: string
    mw: number | null
    quote: string
    source_title: string | null
  }[]
  /** Runs of the document's text around the site's names, each verbatim. */
  excerpts: string[]
}

const termsOf = (json: string): string[] => {
  const v = JSON.parse(json) as unknown
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
}

/** The POWER SITE REVIEW block: the oldest unsettled documents, with their text. */
export async function powerSiteReview(
  db: PipelineDb,
  readRaw: RawReader,
  limit = POWER_SITE_REVIEW_LIMIT,
): Promise<PowerSiteReview[]> {
  const pending = await pendingDocuments(db)
  if (pending.length === 0) return []
  const sites = new Map((await epochLabSites(db)).map((s) => [s.name, s]))
  const out: PowerSiteReview[] = []
  for (const doc of pending) {
    if (out.length >= limit) break
    const html = doc.raw_key ? await readRaw(doc.raw_key) : null
    if (html === null) continue
    const terms = termsOf(doc.terms)
    const epoch = sites.get(doc.site)
    out.push({
      document_id: doc.document_id,
      site: doc.site,
      site_names: terms,
      labs: epoch?.labs ?? [],
      owner: epoch?.owner ?? null,
      users: epoch?.users ?? null,
      filer: filerOf(doc.filer).name,
      form: doc.form,
      file_type: doc.file_type,
      filed: doc.filed,
      known: (await currentTies(db, doc.site)).map((r) => ({
        role: r.role,
        company: r.company_name,
        mw: r.mw,
        quote: r.quote,
        source_title: r.source_title,
      })),
      excerpts: powerExcerpts(documentText(html), terms),
    })
  }
  return out
}

/** Why a tie doesn't hold against the document, or null when it does. */
export function checkTie(
  t: Tie,
  text: string,
  terms: readonly string[],
): { reason: string; detail: string } | null {
  const short = t.quote.slice(0, 120)
  if (!contains(text, t.quote)) return { reason: 'quote-not-in-document', detail: short }
  if (!contains(t.quote, t.company)) return { reason: 'company-not-in-quote', detail: t.company }
  if (!siteNamed(t.quote, terms)) return { reason: 'site-not-in-quote', detail: terms.join(' / ') }
  if (!roleStated(t.quote, t.role)) return { reason: 'role-not-in-quote', detail: t.role }
  if ((t.mw === null) !== (t.mw_meaning === null)) {
    return { reason: 'mw-without-meaning', detail: String(t.mw) }
  }
  if (t.mw !== null && !mwWritten(t.quote, t.mw)) {
    return { reason: 'mw-not-in-quote', detail: `${t.mw} MW` }
  }
  return null
}

interface Listing {
  company: string
  parent: string | null
  ticker: string | null
  unlisted: string | null
}

const norm = (s: string) =>
  comparable(s)
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|corp|corporation|co|company|llc|lp|ltd|plc|holdings|group)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** The companies the hand-read table lists, by name and by listed parent. */
const KNOWN: ReadonlyMap<string, Listing> = (() => {
  const out = new Map<string, Listing>()
  for (const s of curatedPowerSites.parse(curated).sites) {
    for (const l of s.links) {
      const listing = {
        company: l.company,
        parent: l.parent,
        ticker: l.ticker,
        unlisted: l.unlisted,
      }
      if (!out.has(norm(l.company))) out.set(norm(l.company), listing)
      if (l.parent && l.ticker && !out.has(norm(l.parent))) {
        out.set(norm(l.parent), {
          company: l.parent,
          parent: null,
          ticker: l.ticker,
          unlisted: null,
        })
      }
    }
  }
  return out
})()

/** Who a company the judge named is, as the Worker can tell: never from the model. */
export function listingOf(company: string, filerDisplay: string): Listing {
  const known = KNOWN.get(norm(company))
  if (known) return { ...known, company }
  const filer = filerOf(filerDisplay)
  if (norm(filer.name) === norm(company) || norm(filer.name).startsWith(`${norm(company)} `)) {
    return {
      company,
      parent: null,
      ticker: filer.ticker,
      unlisted: filer.ticker ? null : 'files with the SEC, no listed shares',
    }
  }
  return { company, parent: null, ticker: null, unlisted: 'not matched to a listing' }
}

export interface PowerSiteReport {
  accepted: number
  ended: number
  settled: number
  rejected: { reason: string; detail: string; document_id: string }[]
}

/** Gate and store the power-site readings of one judge run, then settle each document answered. */
export async function applyPowerSiteReadings(
  db: PipelineDb,
  readRaw: RawReader,
  readings: readonly JudgePowerSiteReading[],
  now: Date,
): Promise<PowerSiteReport> {
  const report: PowerSiteReport = { accepted: 0, ended: 0, settled: 0, rejected: [] }
  if (!readings.length) return report
  const at = now.toISOString()
  const pending = new Map(
    (await pendingDocuments(db)).map((d) => [`${d.document_id}|${d.site}`, d]),
  )
  for (const reading of readings) {
    const { document_id, site } = reading
    const key = `${document_id}|${site}`
    const doc = pending.get(key)
    if (!doc) {
      report.rejected.push({
        reason: 'not-offered',
        detail: `${document_id} for ${site}`,
        document_id,
      })
      continue
    }
    const html = doc.raw_key ? await readRaw(doc.raw_key) : null
    if (html === null) {
      report.rejected.push({
        reason: 'document-not-stored',
        detail: String(doc.raw_key),
        document_id,
      })
      continue
    }
    pending.delete(key)
    const text = documentText(html)
    const terms = termsOf(doc.terms)
    const ref = documentRef(site, doc, doc.source_url, doc.fetched_at)
    const held = new Set(
      (await currentTies(db, site)).map((r) => comparable(r.quote).toLowerCase()),
    )
    const rows: Parameters<typeof insertTies>[1] = []
    for (const t of reading.ties) {
      const failed = checkTie(t, text, terms)
      if (failed) {
        report.rejected.push({ ...failed, document_id })
        continue
      }
      const quoteKey = comparable(t.quote).toLowerCase()
      if (held.has(quoteKey)) continue
      held.add(quoteKey)
      const listing = listingOf(t.company, doc.filer)
      rows.push({
        id: tieId({
          site,
          role: t.role,
          company_name: listing.company,
          source_url: doc.source_url,
          quote: t.quote,
        }),
        site,
        role: t.role,
        company_name: listing.company,
        parent: listing.parent,
        ticker: listing.ticker,
        unlisted: listing.unlisted,
        mw: t.mw,
        mw_meaning: t.mw_meaning,
        source_title: ref.source_title,
        publisher: ref.publisher,
        published: doc.filed,
        quote: t.quote,
        basis: 'judge',
        accession_no: doc.accession_no,
        form: ref.form,
        filed: doc.filed,
        first_seen_at: at,
        ended_at: null,
        ended_by: null,
        source_url: doc.source_url,
        fetched_at: doc.fetched_at,
      })
    }
    await insertTies(db, rows)
    report.accepted += rows.length
    report.ended += await settleDocument(db, ref, text, at)
    report.settled++
  }
  return report
}
