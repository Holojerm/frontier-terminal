// How the thesis pages read the /api/theses payload: status presentation,
// measured values, a judged event's facts, and the pages sitemap.xml and
// llms.txt list. Pure functions, so the pages carry no formatting logic.
//
// A measured value prints in the `format` the server sends with its claim.
// Context rows are read off the shape of the `detail` the signal recorded
// beside it — `ratios`, `shares` and `rivals` per company, `by_department`,
// `by_key` and `by_lab` breakdowns, a year-earlier base, a trailing window,
// and the Compute thesis's flagship prices and GPU medians.

import { companyName } from './companies'
import { absoluteStamp, count, money } from './terminal-format'
import type { PublicPage } from '#shared/utils/site'
import type { ClaimStatus, ThesisDef, ValueFormat } from './thesis-types'

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

export type ValueKind =
  | 'ratio'
  | 'share'
  | 'count'
  | 'usd'
  | 'usd_per_mtok'
  | 'gpu_hours_per_mtok'
  | 'megawatts'
  | 'plain'

const KIND_OF: Record<ValueFormat, ValueKind> = {
  ratio: 'ratio',
  percent: 'share',
  count: 'count',
  usd: 'usd',
  usd_per_mtok: 'usd_per_mtok',
  gpu_hours_per_mtok: 'gpu_hours_per_mtok',
  megawatts: 'megawatts',
}

/** The server's format when it sent one; otherwise the detail's shape. */
export function valueKind(detail: unknown, format: ValueFormat | null = null): ValueKind {
  if (format) return KIND_OF[format]
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
    case 'usd':
      return `$${count(Math.round(v / 1e6))}M`
    case 'usd_per_mtok':
      return `$${v.toFixed(2)}/MTok`
    case 'gpu_hours_per_mtok':
      return `${v.toFixed(2)} GPU-h/MTok`
    case 'megawatts':
      return `${count(Math.round(v))} MW`
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
  if (typeof d.days === 'number') rows.push({ label: 'Window', value: `trailing ${d.days} days` })
  const value = num(d.value)
  const base = num(d.base_value)
  if (value !== null) rows.push({ label: 'Value', value: formatValue('usd', value) })
  if (base !== null && typeof d.base_date === 'string') {
    rows.push({ label: 'A year earlier', value: `${formatValue('usd', base)} (${d.base_date})` })
  }
  const byCompany = (record: unknown, kind: ValueKind, label: string) => {
    const r = asRecord(record)
    if (!r) return
    const parts = Object.entries(r).flatMap(([id, v]) => {
      const n = num(v)
      return n === null ? [] : [`${companyName(id)} ${formatValue(kind, n)}`]
    })
    if (parts.length) rows.push({ label, value: parts.join(' · ') })
  }
  byCompany(d.ratios, 'ratio', 'Each lab')
  byCompany(d.shares, 'share', 'Each lab')
  byCompany(d.rivals, 'share', 'Rivals, same period')
  const breakdown = (record: unknown, label: string) => {
    const by = asRecord(record)
    if (!by) return
    const parts = Object.entries(by).flatMap(([name, v]) => {
      const n = num(v)
      return n === null ? [] : [`${name} ${count(n)}`]
    })
    if (parts.length) rows.push({ label, value: parts.join(' · ') })
  }
  breakdown(d.by_department, 'By department')
  breakdown(d.by_key, 'Breakdown')
  const byLab = asRecord(d.by_lab)
  if (byLab) {
    const parts = Object.entries(byLab).flatMap(([id, v]) => {
      const n = num(v)
      return n === null ? [] : [`${companyName(id)} ${count(n)}`]
    })
    if (parts.length) rows.push({ label: 'By lab', value: parts.join(' · ') })
  }
  if (typeof d.compare_unavailable === 'string') {
    rows.push({ label: 'Not compared', value: d.compare_unavailable })
  }
  const names = (record: unknown) => Object.keys(asRecord(record) ?? {}).map(companyName)
  const noFeed = names(d.no_feed)
  if (noFeed.length) rows.push({ label: 'No public feed', value: noFeed.join(', ') })
  rows.push(...computeRows(d))
  return rows
}

const perGpuHour = (v: number) => `$${v.toFixed(2)}/GPU-h`

/** The Compute thesis's price readings: each lab's flagship, and the GPU medians beside them. */
function computeRows(d: Record<string, unknown>): DetailRow[] {
  const rows: DetailRow[] = []
  const median = num(d.flagship_median)
  if (median !== null) {
    rows.push({ label: 'Flagship median', value: formatValue('usd_per_mtok', median) })
  }
  const flagships = Object.entries(asRecord(d.flagships) ?? {}).flatMap(([lab, f]) => {
    const r = asRecord(f)
    const blended = num(r?.blended)
    return r && blended !== null
      ? [`${companyName(lab)} ${String(r.model_slug)} ${formatValue('usd_per_mtok', blended)}`]
      : []
  })
  if (flagships.length) rows.push({ label: 'Flagships, blended', value: flagships.join(' · ') })
  const unmapped = Object.keys(asRecord(d.no_flagship) ?? {}).map(companyName)
  if (unmapped.length) rows.push({ label: 'Left out', value: unmapped.join(', ') })
  const changed = Object.entries(asRecord(d.flagship_changed) ?? {}).map(([lab, c]) => {
    const r = asRecord(c)
    return `${companyName(lab)} ${String(r?.from)} → ${String(r?.to)}`
  })
  if (changed.length) rows.push({ label: 'Flagship changed', value: changed.join(' · ') })

  const gpuLine = (gpu: unknown, m: unknown, providers: unknown) => {
    const value = num(m)
    const by = asRecord(providers) ?? {}
    if (typeof gpu !== 'string' || value === null) return null
    const each = Object.entries(by).flatMap(([id, p]) => {
      const v = num(asRecord(p)?.value)
      return v === null ? [] : [`${companyName(id)} ${perGpuHour(v)}`]
    })
    return {
      median: `${perGpuHour(value)} across ${Object.keys(by).length} providers`,
      each: each.join(' · '),
    }
  }
  const main = gpuLine(d.gpu, d.gpu_median, d.gpu_providers)
  if (main) {
    rows.push({ label: `${String(d.gpu)} median`, value: main.median })
    if (main.each) rows.push({ label: `${String(d.gpu)} by provider`, value: main.each })
  }
  const failed = Object.keys(asRecord(d.gpu_failed) ?? {}).map(companyName)
  if (failed.length) rows.push({ label: 'No price today', value: failed.join(', ') })
  const context = asRecord(d.context)
  const ctx = context && gpuLine(context.gpu, context.gpu_median, context.providers)
  const ratio = num(context?.ratio)
  if (context && ctx && ratio !== null) {
    rows.push({
      label: `${String(context.gpu)} ratio, context only`,
      value: `${formatValue('gpu_hours_per_mtok', ratio)} (median ${ctx.median})`,
    })
  }
  if (typeof d.void_reason === 'string') rows.push({ label: 'Not counted', value: d.void_reason })
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
  // An impact of null is a feed that publishes none (Anthropic's Atom history).
  if ('impact' in facts && facts.impact === null && 'started_at' in facts) {
    set('impact', FACT_LABELS.impact!, 'not published')
  }

  const known = FACT_ORDER.flatMap((k) => (rows.has(k) ? [rows.get(k)!] : []))
  const rest = [...rows].filter(([k]) => !FACT_ORDER.includes(k)).map(([, row]) => row)
  return [...known, ...rest]
}

// ---- crawler listing ----------------------------------------------------------

/**
 * The thesis pages, in the shape `definePageMeta({ publicPage })` produces for
 * a static page. /theses/[id] is one pattern, not N URLs, so the route table
 * cannot list them; sitemap.xml and llms.txt append them from the registry.
 */
export const thesisPages = (
  theses: readonly Pick<ThesisDef, 'id' | 'company' | 'title'>[],
): PublicPage[] =>
  theses.map((t) => ({
    path: thesisPath(t.id),
    changefreq: 'daily',
    priority: '0.8',
    title: `${t.title ?? companyName(t.company)} thesis`,
    summary: `The ${t.title ?? companyName(t.company)} thesis: each claim, its kill condition, its current status, and the readings and verdicts behind it.`,
  }))
