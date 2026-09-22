// The disclosed-revenue axis: what a lab, or the public parent that
// consolidates it, has reported to the SEC in XBRL — and, for the labs that
// have reported nothing, exactly that. Primary source only: a press
// run-rate is a claim about a number, not the number, and the panel says so
// instead of printing one.
//
// Read-only over the `entities` table like terminal-db.ts; split out because
// the period arithmetic (which filing's value a period is shown from) is its
// own thing and test/terminal-revenue.test.ts drives the pure half.

import { eq } from 'drizzle-orm'

import type {
  BigFour,
  RevenueData,
  RevenueFilerView,
  RevenuePeriod,
  RevenueProviderView,
  SourceRef,
} from '#shared/utils/terminal-types'

import * as tables from '../db/schema'
import { REVENUE_TAGS } from '../pipeline/parsers/sec/edgar-companyfacts'
import type { PipelineDb } from '../pipeline/store'
import { sourceStamps, type QueryContext } from './terminal-db'
import { byString, num, parseJson, str } from './terminal-json'
import { PROVIDER_DISPLAY, PROVIDER_ORDER, labelOf } from './terminal-sources'

export const REVENUE_RULE =
  'Primary source only: audited SEC disclosures read from EDGAR’s XBRL company facts, each value linked to the filing that reported it. ' +
  'No audited disclosure on file means nothing is shown — press-reported run-rates are deliberately not shown.'

const DAY_MS = 86_400_000

/** EDGAR's filing index for an accession: the same composition the incident
 * lanes use for their vendor URLs, verified to resolve for SPCX's 10-Q. */
export function filingIndexUrl(cik: string, accessionNo: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNo.replace(/-/g, '')}/`
}

export function companyfactsSourceId(ticker: string): string {
  return `edgar-companyfacts-${ticker.toLowerCase()}`
}

export function submissionsSourceId(ticker: string): string {
  return `edgar-submissions-${ticker.toLowerCase()}`
}

const daysBetween = (start: string, end: string) =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1

/** One stored fact as the panel reads it; null when the payload is not a fact. */
export function revenuePeriodFromPayload(
  entity_key: string,
  payload: string,
  prov: { source_url: string; fetched_at: string },
): (RevenuePeriod & { cik: string; entity_name: string | null }) | null {
  const p = parseJson(payload)
  if (!p) return null
  const cik = str(p.cik)
  const start = str(p.start)
  const end = str(p.end)
  const accession_no = str(p.accession_no)
  const tag = str(p.tag)
  const form = str(p.form)
  const filed = str(p.filed)
  const val = num(p.val)
  if (!cik || !start || !end || !accession_no || !tag || !form || !filed || val === null) {
    return null
  }
  return {
    entity_key,
    cik,
    entity_name: str(p.entity_name),
    start,
    end,
    days: daysBetween(start, end),
    fy: num(p.fy),
    fp: str(p.fp),
    form,
    filed,
    accession_no,
    filing_url: filingIndexUrl(cik, accession_no),
    tag,
    val,
    frame: str(p.frame),
    source_url: prov.source_url,
    fetched_at: prov.fetched_at,
  }
}

const tagRank = (tag: string) => {
  const i = REVENUE_TAGS.indexOf(tag)
  return i === -1 ? REVENUE_TAGS.length : i
}

/** Newest filing first; within one filing the preferred tag first. */
function preferred(a: RevenuePeriod, b: RevenuePeriod): number {
  return (
    byString(b.filed, a.filed) ||
    byString(b.accession_no, a.accession_no) ||
    tagRank(a.tag) - tagRank(b.tag)
  )
}

/**
 * Pure: per (start, end) the value the newest filing reported, the rest as
 * superseded. Periods are listed newest end first, and for one end date the
 * longest span first (the year above its final quarter).
 */
export function splitPeriods<T extends RevenuePeriod>(
  rows: readonly T[],
): {
  periods: T[]
  superseded: T[]
  tags: string[]
} {
  const byPeriod = new Map<string, T[]>()
  for (const row of rows) {
    const key = `${row.start}\n${row.end}`
    const list = byPeriod.get(key) ?? []
    list.push(row)
    byPeriod.set(key, list)
  }
  const periods: T[] = []
  const superseded: T[] = []
  for (const list of byPeriod.values()) {
    const [shown, ...rest] = [...list].sort(preferred)
    periods.push(shown!)
    superseded.push(...rest)
  }
  const order = (a: RevenuePeriod, b: RevenuePeriod) =>
    byString(b.end, a.end) || b.days - a.days || byString(b.filed, a.filed)
  periods.sort(order)
  superseded.sort(order)
  const tags = [...new Set(rows.map((r) => r.tag))].sort((a, b) => tagRank(a) - tagRank(b))
  return { periods, superseded, tags }
}

/** A lab's `filer` row (server/pipeline/parsers/sec/pending-filers.ts), as the panel needs it. */
interface ResolvedFilerView {
  cik: string
  name: string
  form: string
  accession_no: string
  file_date: string
}

function resolvedFilerFromPayload(payload: string): ResolvedFilerView | null {
  const p = parseJson(payload)
  const cik = str(p?.cik)
  const name = str(p?.name)
  const form = str(p?.resolved_form)
  const accession_no = str(p?.resolved_accession)
  const file_date = str(p?.resolved_file_date)
  if (!p || !cik || !name || !form || !accession_no || !file_date) return null
  return { cik, name, form, accession_no, file_date }
}

export async function queryRevenue(db: PipelineDb, ctx: QueryContext): Promise<RevenueData> {
  const [rows, filerRows, stamps] = await Promise.all([
    db
      .select({
        entity_key: tables.entities.entity_key,
        provider: tables.entities.provider,
        payload: tables.entities.payload,
        source_url: tables.entities.source_url,
        fetched_at: tables.entities.fetched_at,
      })
      .from(tables.entities)
      .where(eq(tables.entities.entity_type, 'revenue')),
    db
      .select({ provider: tables.entities.provider, payload: tables.entities.payload })
      .from(tables.entities)
      .where(eq(tables.entities.entity_type, 'filer')),
    sourceStamps(db),
  ])
  const resolved = new Map<string, ResolvedFilerView>()
  for (const row of filerRows) {
    const view = resolvedFilerFromPayload(row.payload)
    if (view) resolved.set(row.provider, view)
  }

  const providers: RevenueProviderView[] = []
  for (const provider of PROVIDER_ORDER) {
    const display = PROVIDER_DISPLAY[provider]
    // The audited file first; a filer the poll resolved from the lab's own
    // S-1 fills a null entry as an issuer, keyed by provider (no ticker yet).
    const tagged = ctx.revenueFilers.get(provider) ?? null
    const auto = tagged ? null : (resolved.get(provider) ?? null)
    const filer = tagged ?? (auto ? { ticker: null, relation: 'issuer' as const } : null)
    if (!filer) {
      providers.push({
        provider,
        display,
        disclosure: 'none',
        filer: null,
        periods: [],
        superseded: [],
        tags: [],
        sources: [],
      })
      continue
    }

    const cik = filer.ticker ? (ctx.whitelist.get(filer.ticker) ?? null) : (auto?.cik ?? null)
    const feedKey = filer.ticker ?? provider
    const factsId = companyfactsSourceId(feedKey)
    const registered = ctx.registry.sources.find((s) => s.source_id === factsId)
    const parsed = rows
      .filter((r) => r.provider === provider)
      .map((r) => revenuePeriodFromPayload(r.entity_key, r.payload, r))
      .filter((r): r is NonNullable<typeof r> => r !== null && (cik === null || r.cik === cik))
    const { periods, superseded, tags } = splitPeriods(parsed)

    const sources: SourceRef[] = [factsId, submissionsSourceId(feedKey)]
      .map((id) => {
        const stamp = stamps.get(id)
        return stamp
          ? {
              source_id: id,
              label: labelOf(id).label,
              source_url: stamp.newest.source_url,
              fetched_at: stamp.newest.fetched_at,
            }
          : null
      })
      .filter((s): s is SourceRef => s !== null)

    const view: RevenueFilerView = {
      ticker: filer.ticker,
      cik: cik ?? '',
      entity_name: parsed[0]?.entity_name ?? auto?.name ?? null,
      relation: filer.relation,
      tagged_by: tagged ? 'sources.yaml' : 'resolved',
      resolved_from:
        auto && cik
          ? {
              form: auto.form,
              accession_no: auto.accession_no,
              file_date: auto.file_date,
              filing_url: filingIndexUrl(cik, auto.accession_no),
            }
          : null,
      source_id: factsId,
      caveat:
        registered?.caveat ??
        ctx.derivedTemplates.find((t) => t.id === 'edgar-companyfacts')?.caveat ??
        null,
    }
    providers.push({
      provider: provider as BigFour,
      display,
      disclosure: periods.length ? filer.relation : 'no_rows',
      filer: view,
      periods: periods.map(stripFiler),
      superseded: superseded.map(stripFiler),
      tags,
      sources,
    })
  }

  return {
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
    providers,
    rule: REVENUE_RULE,
  }
}

const stripFiler = ({
  cik: _cik,
  entity_name: _name,
  ...period
}: RevenuePeriod & { cik: string; entity_name: string | null }): RevenuePeriod => period
