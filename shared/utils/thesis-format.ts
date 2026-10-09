// How the thesis pages read the /api/theses payload: status presentation,
// measured values, a judged event's facts, and the pages sitemap.xml and
// llms.txt list. Pure functions, so the pages carry no formatting logic.
//
// The payload names a claim's signal only in prose (`signal_label`), so a
// measured value is formatted by the shape of the `detail` the signal
// recorded beside it — `ratios` is a spend premium, `shares` a token share,
// `by_department` a role count. A new signal with a new shape falls back to
// the bare number until it is taught here.

import { companyName } from './companies'
import { absoluteStamp, count, money } from './terminal-format'
import type { PublicPage } from './site'
import type { ClaimStatus, ThesisDef } from './thesis-types'

export const thesisPath = (id: string) => `/theses/${id}`

export const journalUrl = (repo: string, docPath: string) => `${repo}/blob/main/${docPath}`

export const datasetRequestUrl = (repo: string) => `${repo}/issues/new?template=dataset-request.yml`

type BadgeColor = 'success' | 'warning' | 'error' | 'neutral'

/** Order is severity-first so a summary reads worst to best. */
export const STATUS_ORDER: readonly ClaimStatus[] = ['broken', 'weakening', 'holding', 'unresolved']

/** Every status pairs its color with a word and an icon (DESIGN.md › Contrast). */
export const STATUS_META: Record<ClaimStatus, { label: string; color: BadgeColor; icon: string }> =
  {
    holding: { label: 'Holding', color: 'success', icon: 'i-lucide-circle-check' },
    weakening: { label: 'Weakening', color: 'warning', icon: 'i-lucide-triangle-alert' },
    broken: { label: 'Broken', color: 'error', icon: 'i-lucide-circle-x' },
    unresolved: { label: 'Unresolved', color: 'neutral', icon: 'i-lucide-circle-help' },
  }

export function statusCounts(claims: readonly { status: ClaimStatus }[]) {
  return STATUS_ORDER.map((status) => ({
    status,
    n: claims.filter((c) => c.status === status).length,
  })).filter((c) => c.n > 0)
}

export const POSITION_LABEL = { long: 'Long', short: 'Short', none: 'No position' } as const

// ---- measured values --------------------------------------------------------

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export type ValueKind = 'ratio' | 'share' | 'count' | 'plain'

export function valueKind(detail: unknown): ValueKind {
  const d = asRecord(detail)
  if (!d) return 'plain'
  if (asRecord(d.ratios)) return 'ratio'
  if (asRecord(d.shares)) return 'share'
  if (asRecord(d.by_department)) return 'count'
  return 'plain'
}

/** '1.87×' / '26.4%' / '1,234' — and a share tick never ends in a trailing '.0'. */
export function formatValue(kind: ValueKind, v: number): string {
  switch (kind) {
    case 'ratio':
      return `${v.toFixed(2)}×`
    case 'share':
      return `${Number((v * 100).toFixed(1))}%`
    case 'count':
      return count(Math.round(v))
    default:
      return String(Number(v.toFixed(4)))
  }
}

export interface DetailRow {
  label: string
  value: string
}

/** The context a reading carries beside its value: the window, and each lab's figure. */
export function detailRows(detail: unknown): DetailRow[] {
  const d = asRecord(detail)
  if (!d) return []
  const rows: DetailRow[] = []
  const window = asRecord(d.window)
  if (window && typeof window.from === 'string' && typeof window.to === 'string') {
    rows.push({ label: 'Window', value: `${window.from} to ${window.to}` })
  }
  const byCompany = (record: unknown, kind: ValueKind) => {
    const r = asRecord(record)
    if (!r) return
    const parts = Object.entries(r).flatMap(([id, v]) => {
      const n = num(v)
      return n === null ? [] : [`${companyName(id)} ${formatValue(kind, n)}`]
    })
    if (parts.length) rows.push({ label: 'Each lab', value: parts.join(' · ') })
  }
  byCompany(d.ratios, 'ratio')
  byCompany(d.shares, 'share')
  const by = asRecord(d.by_department)
  if (by) {
    const parts = Object.entries(by).flatMap(([dept, v]) => {
      const n = num(v)
      return n === null ? [] : [`${dept} ${count(n)}`]
    })
    if (parts.length) rows.push({ label: 'By department', value: parts.join(' · ') })
  }
  return rows
}

/** 'Oct 8' for a YYYY-MM-DD chart tick. */
export const dayLabel = (date: string) =>
  absoluteStamp(`${date}T00:00:00Z`).replace(/ \d\d:\d\dZ$/, '')

// ---- judged facts ------------------------------------------------------------

const FACT_LABELS: Record<string, string> = {
  model_slug: 'Model',
  cut_pct: 'Cut',
  title: 'Title',
  kind: 'Kind',
  impact: 'Impact',
  hours: 'Duration',
  started_at: 'Started',
  resolved_at: 'Resolved',
}

const FACT_ORDER = [
  'title',
  'kind',
  'model_slug',
  'cut_pct',
  'input_before',
  'output_before',
  'impact',
  'started_at',
  'resolved_at',
  'hours',
]

const sentence = (key: string) => {
  const spaced = key.replaceAll('_', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** What the Worker computed about an event, in the words a reader expects. */
export function factRows(facts: Record<string, unknown>): DetailRow[] {
  const rows = new Map<string, DetailRow>()
  const set = (key: string, label: string, value: string) => rows.set(key, { label, value })

  for (const [key, raw] of Object.entries(facts)) {
    if (raw === null || raw === undefined) continue
    const n = num(raw)
    switch (key) {
      case 'cut_pct':
        if (n !== null) set(key, FACT_LABELS.cut_pct!, `−${n}%`)
        break
      case 'hours':
        if (n !== null) set(key, FACT_LABELS.hours!, `${n} h`)
        break
      case 'started_at':
      case 'resolved_at':
        if (typeof raw === 'string') set(key, FACT_LABELS[key]!, absoluteStamp(raw))
        break
      case 'input_before':
      case 'input_after':
      case 'output_before':
      case 'output_after':
        break
      default:
        set(
          key,
          FACT_LABELS[key] ?? sentence(key),
          typeof raw === 'object' ? JSON.stringify(raw) : String(raw),
        )
    }
  }

  const price = (side: 'input' | 'output') => {
    const before = num(facts[`${side}_before`])
    const after = num(facts[`${side}_after`])
    if (before === null && after === null) return
    set(
      `${side}_before`,
      `${side === 'input' ? 'Input' : 'Output'} per Mtok`,
      `${money(before)} → ${money(after)}`,
    )
  }
  price('input')
  price('output')

  // A resolved_at of null is an incident still open; saying nothing would hide that.
  if ('resolved_at' in facts && facts.resolved_at === null && 'started_at' in facts) {
    set('resolved_at', FACT_LABELS.resolved_at!, 'not yet')
  }

  const known = FACT_ORDER.flatMap((k) => (rows.has(k) ? [rows.get(k)!] : []))
  const rest = [...rows].filter(([k]) => !FACT_ORDER.includes(k)).map(([, row]) => row)
  return [...known, ...rest]
}

// ---- crawler listing ----------------------------------------------------------

export const THESES_INDEX_SUMMARY =
  'Open investment theses on public companies, each a set of claims checked against a kill condition written before the data arrived.'

/**
 * The thesis pages, in the shape `definePageMeta({ publicPage })` produces for
 * a static page. /theses/[id] is one pattern, not N URLs, so the route table
 * cannot list them; sitemap.xml and llms.txt append them from the registry.
 */
export const thesisPages = (theses: readonly Pick<ThesisDef, 'id' | 'company'>[]): PublicPage[] =>
  theses.map((t) => ({
    path: thesisPath(t.id),
    changefreq: 'daily',
    priority: '0.8',
    title: `${companyName(t.company)} thesis`,
    summary: `The ${companyName(t.company)} thesis: each claim, its kill condition, its current status, and the readings and verdicts behind it.`,
  }))
