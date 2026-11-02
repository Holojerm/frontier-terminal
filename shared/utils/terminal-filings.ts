// The revenue axis regrouped by filing: one entry per accession that reported
// at least one period the panel reads, with every value that filing reported —
// the ones the panel still shows and the ones a later filing restated. Derived
// from the cached /api/revenue payload, so a filing page and the revenue panel
// cannot disagree about a number, and the sitemap enumerates exactly the
// filings a page exists for.

import type {
  LabId,
  RevenueData,
  RevenueFilerView,
  RevenuePeriod,
  SourceRef,
} from './terminal-types'

export interface FilingPeriod extends RevenuePeriod {
  /** The later filing whose value for the same period the revenue panel shows instead; null when this one is shown. */
  restated_by: { accession_no: string; form: string; filed: string } | null
}

export interface RevenueFiling {
  accession_no: string
  form: string
  filed: string
  filing_url: string
  provider: LabId
  display: string
  filer: RevenueFilerView
  /** Newest end first, longest span first within one end date. */
  periods: FilingPeriod[]
  /** The revenue feed's sources, as the panel cites them. */
  sources: SourceRef[]
}

/** EDGAR accession numbers: ten-digit filer id, two-digit year, six-digit sequence. */
export const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/

export const filingPath = (accession_no: string) => `/filings/${accession_no}`

const byEndThenSpan = (a: RevenuePeriod, b: RevenuePeriod) =>
  b.end.localeCompare(a.end) || b.days - a.days

/** Newest filing first. */
export function revenueFilings(data: RevenueData): RevenueFiling[] {
  const out = new Map<string, RevenueFiling>()
  for (const p of data.providers) {
    if (!p.filer) continue
    const shownFor = new Map(p.periods.map((r) => [`${r.start}\n${r.end}`, r]))
    const rows: FilingPeriod[] = [
      ...p.periods.map((r) => ({ ...r, restated_by: null })),
      ...p.superseded.map((r) => {
        const shown = shownFor.get(`${r.start}\n${r.end}`)
        return {
          ...r,
          restated_by: shown
            ? { accession_no: shown.accession_no, form: shown.form, filed: shown.filed }
            : null,
        }
      }),
    ]
    for (const r of rows) {
      let filing = out.get(r.accession_no)
      if (!filing) {
        filing = {
          accession_no: r.accession_no,
          form: r.form,
          filed: r.filed,
          filing_url: r.filing_url,
          provider: p.provider,
          display: p.display,
          filer: p.filer,
          periods: [],
          sources: p.sources,
        }
        out.set(r.accession_no, filing)
      }
      filing.periods.push(r)
    }
  }
  const filings = [...out.values()]
  for (const f of filings) f.periods.sort(byEndThenSpan)
  return filings.sort(
    (a, b) => b.filed.localeCompare(a.filed) || b.accession_no.localeCompare(a.accession_no),
  )
}

/**
 * A period as an analyst names it: FY2025, H1 2026, Q3 2026, 9M 2026. Named
 * from the dates, never from the fact's fy/fp, which describe the filing — a
 * 10-Q's prior-year comparative carries the current fiscal period. A span
 * that does not end on a calendar quarter is named by its length and end month.
 */
export function periodName(p: Pick<RevenuePeriod, 'end' | 'days'>): string {
  const year = p.end.slice(0, 4)
  const month = Number(p.end.slice(5, 7))
  const to = p.end.slice(0, 7)
  if (p.days >= 350) return month === 12 ? `FY${year}` : `12 months to ${to}`
  if (p.days >= 260) return month === 9 ? `9M ${year}` : `9 months to ${to}`
  if (p.days >= 170) {
    if (month === 6) return `H1 ${year}`
    if (month === 12) return `H2 ${year}`
    return `6 months to ${to}`
  }
  if (p.days >= 80) return month % 3 === 0 ? `Q${month / 3} ${year}` : `3 months to ${to}`
  return `${p.days} days to ${p.end}`
}

/**
 * The periods a filing is about, as its title names them: every period ending
 * on its newest end date, and the newest full year when that is not among
 * them (an S-1's audited year beside its interim half). Comparatives — the
 * same span a year earlier — are left to the table.
 */
export function headlinePeriods(periods: readonly RevenuePeriod[]): RevenuePeriod[] {
  const newestEnd = periods.reduce((m, p) => (p.end > m ? p.end : m), '')
  const current = periods.filter((p) => p.end === newestEnd)
  const year = periods
    .filter((p) => p.days >= 350)
    .sort((a, b) => b.end.localeCompare(a.end))
    .at(0)
  const picked = year && !current.includes(year) ? [year, ...current] : current
  return [...picked].sort((a, b) => a.end.localeCompare(b.end) || a.days - b.days)
}

/** Common names for parent filers whose legal name is not what an analyst types. */
const FILER_NAME: Record<string, string> = { SPCX: 'SpaceX', GOOGL: 'Alphabet' }

/** "Alphabet Inc." → "Alphabet", "Anthropic, PBC" → "Anthropic". */
export function filerName(filer: Pick<RevenueFilerView, 'ticker' | 'entity_name'>): string | null {
  if (filer.ticker && FILER_NAME[filer.ticker]) return FILER_NAME[filer.ticker]!
  return filer.entity_name?.replace(/,?\s+(Inc|Corp|Corporation|PBC|LLC|Ltd|Co)\.?$/i, '') ?? null
}

/**
 * The query an analyst types for this filing: whose revenue, which form, which
 * periods. "Anthropic S-1 revenue: FY2025 and H1 2026"; a parent's filing says
 * it is the parent's, because the lab's name alone would claim the number.
 */
export function filingTitle(f: RevenueFiling): string {
  const names = headlinePeriods(f.periods).map(periodName)
  const when = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
  const filer = filerName(f.filer) ?? f.display
  const subject =
    f.filer.relation === 'issuer'
      ? `${f.display} ${f.form} revenue`
      : f.filer.segment_label
        ? `${f.filer.segment_label} revenue, ${filer} ${f.form}`
        : `${filer} ${f.form} revenue (${f.display} parent)`
  return when ? `${subject}: ${when}` : subject
}
