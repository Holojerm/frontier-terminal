// The disclosures axis: each lab's own index of misalignment reports and
// notices, the dates printed on each report's page, and how long each report
// took from discovery to publication. Read-only over `entities` and
// `changes`; split out like terminal-rankings.ts so the pure half
// (summarizeDisclosures) is tested without a database.
//
// What this axis measures is disclosure practice. A lab with an index will
// always show more entries than a lab without one, so nothing here ranks labs
// on a count: a lab with no index carries the audit's reason
// (sources.yaml `cut`) instead of a zero.
//
// The publication date a lag is measured to is, in order:
//   printed       the report page's own "Disclosure date" line;
//   first_listed  the earliest date the index has printed beside the entry
//                 across every observation this store holds — the current
//                 row, plus every before/after in the change log. The index
//                 date moves when a report is revised, so the earliest one
//                 seen is the closest the store has to the day it went up.

import { eq, inArray } from 'drizzle-orm'

import type {
  BigFour,
  DisclosureProviderView,
  DisclosuresData,
  DisclosureTimeline,
  DisclosureView,
  Prov,
  SourceRef,
} from '#shared/utils/terminal-types'

import * as tables from '../db/schema'
import type { PipelineDb } from '../pipeline/store'
import { sourceStamps, type QueryContext } from './terminal-db'
import { byString, parseJson, str, type Json } from './terminal-json'
import { DISCLOSURE_SOURCES, PROVIDER_DISPLAY, PROVIDER_ORDER, labelOf } from './terminal-sources'

const DAY_MS = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

type EntryBase = Omit<DisclosureView, 'timeline_status' | 'timeline'>

export interface TimelineObservation extends Prov {
  provider: string
  entry_id: string
  title: string
  lines: { label: string; value: string }[]
  discovered_on: string | null
  disclosed_on: string | null
}

export function entryFromPayload(
  base: { entity_key: string; provider: string; source_url: string; fetched_at: string },
  p: Json,
): EntryBase | null {
  const kind = p.kind === 'report' || p.kind === 'notice' ? p.kind : null
  const entry_id = str(p.entry_id)
  const title = str(p.title)
  const summary = str(p.summary)
  const listed_on = str(p.listed_on)
  const entry_url = str(p.entry_url)
  if (!kind || !entry_id || !title || !summary || !listed_on || !entry_url) return null
  return {
    entity_key: base.entity_key,
    provider: base.provider as BigFour,
    kind,
    entry_id,
    title,
    summary,
    model: str(p.model),
    observed_during: str(p.observed_during),
    listed_on,
    entry_url,
    source_url: base.source_url,
    fetched_at: base.fetched_at,
  }
}

export function timelineFromPayload(
  base: { provider: string; source_url: string; fetched_at: string },
  p: Json,
): TimelineObservation | null {
  const entry_id = str(p.entry_id)
  const title = str(p.title)
  if (!entry_id || !title || !Array.isArray(p.lines)) return null
  const lines = p.lines.flatMap((l) => {
    if (typeof l !== 'object' || l === null || Array.isArray(l)) return []
    const label = str((l as Json).label)
    const value = str((l as Json).value)
    return label && value ? [{ label, value }] : []
  })
  const date = (v: unknown) => {
    const s = str(v)
    return s && ISO_DATE.test(s) ? s : null
  }
  return {
    provider: base.provider,
    entry_id,
    title,
    lines,
    discovered_on: date(p.discovered_on),
    disclosed_on: date(p.disclosed_on),
    source_url: base.source_url,
    fetched_at: base.fetched_at,
  }
}

/** Whole calendar days from one ISO date to another; null if either is missing or the order is reversed. */
export function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null
  const days = Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  )
  return Number.isFinite(days) && days >= 0 ? days : null
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

const sameTitle = (a: string, b: string) =>
  a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

const timelineKey = (provider: string, entryId: string) => `${provider}:${entryId}`

/**
 * Join each index entry to its report page's dates. `firstListed` maps
 * `<provider>:<entry_id>` to the earliest listed_on the store has seen.
 */
export function joinDisclosures(
  entries: readonly EntryBase[],
  timelines: readonly TimelineObservation[],
  firstListed: ReadonlyMap<string, string>,
): DisclosureView[] {
  const byKey = new Map(timelines.map((t) => [timelineKey(t.provider, t.entry_id), t]))
  const views = entries.map((e): DisclosureView => {
    if (e.kind === 'notice') return { ...e, timeline_status: 'not_applicable', timeline: null }
    const t = byKey.get(timelineKey(e.provider, e.entry_id))
    if (!t) return { ...e, timeline_status: 'not_fetched', timeline: null }
    if (!sameTitle(t.title, e.title))
      return { ...e, timeline_status: 'title_mismatch', timeline: null }
    const listed = firstListed.get(timelineKey(e.provider, e.entry_id)) ?? e.listed_on
    const disclosed_on = t.disclosed_on ?? listed
    const timeline: DisclosureTimeline = {
      lines: t.lines,
      discovered_on: t.discovered_on,
      disclosed_on,
      disclosed_basis: t.disclosed_on ? 'printed' : 'first_listed',
      days_to_disclosure: daysBetween(t.discovered_on, disclosed_on),
      source_url: t.source_url,
      fetched_at: t.fetched_at,
    }
    return { ...e, timeline_status: 'ok', timeline }
  })
  // Newest listed first; reports before notices on the same day; key breaks ties.
  return views.sort((a, b) =>
    a.listed_on !== b.listed_on
      ? byString(b.listed_on, a.listed_on)
      : a.kind !== b.kind
        ? byString(b.kind, a.kind)
        : byString(a.entity_key, b.entity_key),
  )
}

export interface DisclosureRegistry {
  caveatOf: (sourceId: string) => string | null
  reasonOf: (cutId: string) => string | null
  sourceRef: (sourceId: string) => SourceRef | null
}

export function summarizeDisclosures(
  entries: readonly DisclosureView[],
  registry: DisclosureRegistry,
): DisclosureProviderView[] {
  return PROVIDER_ORDER.map((provider): DisclosureProviderView => {
    const backing = DISCLOSURE_SOURCES[provider]
    const display = PROVIDER_DISPLAY[provider]
    if ('cut_id' in backing) {
      // Honest cut — never a fabricated zero (sources.yaml `cut.<lab>-disclosures`).
      return {
        provider,
        display,
        feed: 'no_public_feed',
        reason:
          registry.reasonOf(backing.cut_id) ??
          `${display} publishes no misalignment disclosure index.`,
        caveat: null,
        reports: 0,
        notices: 0,
        median_days_to_disclosure: null,
        timed_reports: 0,
        sources: [],
      }
    }
    const mine = entries.filter((e) => e.provider === provider)
    const lags = mine.flatMap((e) =>
      e.timeline?.days_to_disclosure != null ? [e.timeline.days_to_disclosure] : [],
    )
    const ref = registry.sourceRef(backing.source_id)
    return {
      provider,
      display,
      feed: mine.length > 0 ? 'ok' : 'no_rows',
      reason: null,
      caveat: registry.caveatOf(backing.source_id),
      reports: mine.filter((e) => e.kind === 'report').length,
      notices: mine.filter((e) => e.kind === 'notice').length,
      median_days_to_disclosure: median(lags),
      timed_reports: lags.length,
      sources: ref ? [ref] : [],
    }
  })
}

/** The earliest listed_on per entry across the current rows and every change row. */
export function earliestListed(
  observations: readonly { provider: string; payload: Json | null }[],
): Map<string, string> {
  const out = new Map<string, string>()
  for (const { provider, payload } of observations) {
    if (!payload) continue
    const id = str(payload.entry_id)
    const listed = str(payload.listed_on)
    if (!id || !listed || !ISO_DATE.test(listed)) continue
    const key = timelineKey(provider, id)
    const held = out.get(key)
    if (!held || listed < held) out.set(key, listed)
  }
  return out
}

export async function queryDisclosures(
  db: PipelineDb,
  ctx: QueryContext,
): Promise<DisclosuresData> {
  const [rows, changes, stamps] = await Promise.all([
    db
      .select()
      .from(tables.entities)
      .where(inArray(tables.entities.entity_type, ['disclosure', 'disclosure_timeline'])),
    db
      .select({
        provider: tables.changes.provider,
        before_json: tables.changes.before_json,
        after_json: tables.changes.after_json,
      })
      .from(tables.changes)
      .where(eq(tables.changes.entity_type, 'disclosure')),
    sourceStamps(db),
  ])

  const entries: EntryBase[] = []
  const timelines: TimelineObservation[] = []
  const observations: { provider: string; payload: Json | null }[] = []
  for (const row of rows) {
    const payload = parseJson(row.payload)
    if (!payload) continue
    if (row.entity_type === 'disclosure') {
      const entry = entryFromPayload(row, payload)
      if (entry) entries.push(entry)
      observations.push({ provider: row.provider, payload })
    } else {
      const t = timelineFromPayload(row, payload)
      if (t) timelines.push(t)
    }
  }
  for (const c of changes) {
    observations.push({ provider: c.provider, payload: parseJson(c.before_json) })
    observations.push({ provider: c.provider, payload: parseJson(c.after_json) })
  }

  const views = joinDisclosures(entries, timelines, earliestListed(observations))
  const providers = summarizeDisclosures(views, {
    caveatOf: (id) => ctx.registry.sources.find((s) => s.source_id === id)?.caveat ?? null,
    reasonOf: (id) => ctx.registry.cuts.find((c) => c.id === id)?.reason ?? null,
    sourceRef: (id) => {
      const stamp = stamps.get(id)
      return stamp
        ? {
            source_id: id,
            label: labelOf(id).label,
            source_url: stamp.newest.source_url,
            fetched_at: stamp.newest.fetched_at,
          }
        : null
    },
  })

  return {
    as_of: ctx.as_of,
    computed_at: ctx.now().toISOString(),
    providers,
    entries: views,
  }
}
