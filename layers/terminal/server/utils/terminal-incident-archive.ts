// Reads of the archived status-page incidents (archived_incidents,
// archive_captures axis status): the Internet Archive's copies of each lab's
// own status feed, backfilled by scripts/wayback-backfill.ts --axis status.
// Kept out of the live derivations on purpose: the incident windows, the
// signal band, the alerts and the judge read entities only.
//
// What is shown is a count per lab per month, beside how much of the month
// the copies reach. A feed lists only its newest entries, so a copy speaks
// for the stretch from its oldest listed start to the moment the Archive took
// it; a month between two copies that don't meet is counted only as far as
// they reach. No uptime or duration figure is computed: those would need
// every incident, and copies can't promise that.

import { eq } from 'drizzle-orm'

import type {
  IncidentArchiveLab,
  IncidentArchiveView,
  LabId,
} from '../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import { ARCHIVE_FROM } from '#layers/core/server/utils/archive-floor'
import {
  STATUS_ARCHIVE_ERAS,
  STATUS_ARCHIVE_GAPS,
  STATUS_ARCHIVE_NOT_COVERED,
  STATUS_LIVE_FROM,
} from '../pipeline/archive/status-eras'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import { byString } from '#layers/core/server/utils/terminal-json'
import { PROVIDER_DISPLAY } from '#layers/core/server/utils/terminal-sources'

export const INCIDENT_ARCHIVE_METHOD =
  'Before our first read of each lab’s status feed, the history comes from the Internet Archive’s copies of the same feed (source_id wayback:<era>). We read every copy the Archive holds (one a month for Google Cloud, whose copies each list a year), and an incident listed in many copies is one row, in the state the newest copy gives it. ' +
  'A feed lists only its newest incidents, so a copy speaks for the stretch from the oldest start it lists to the moment the Archive took it. A month counts the incidents that started in it, and covered says how much of the month some copy reaches: a month under 100% can hold incidents no copy listed. ' +
  'Counts are what each vendor chose to post, filtered as the live feed is (Google to Gemini and Vertex AI products; xAI without incidents filed only under Cursor’s third-party model component). We don’t compute uptime or durations from copies. Archived incidents never reach the live windows, alerts or the judge.'

const DAY_MS = 86_400_000

/** One incident as the read side holds it. */
export interface ArchivedIncidentStart {
  provider: string
  started_at: string
  components: string[]
}

/** One status copy as the read side holds it. */
export interface StatusCopy {
  provider: string
  status: string
  captured_at: string
  covers_from: string | null
}

const monthOf = (iso: string) => iso.slice(0, 7)
const monthStart = (month: string) => Date.parse(`${month}-01T00:00:00Z`)
const nextMonth = (month: string) => {
  const d = new Date(monthStart(month))
  d.setUTCMonth(d.getUTCMonth() + 1)
  return d.toISOString().slice(0, 7)
}

/** The union of [from, to) intervals, merged, ascending. */
function union(intervals: readonly [number, number][]): [number, number][] {
  const sorted = [...intervals].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out: [number, number][] = []
  for (const [a, b] of sorted) {
    const last = out.at(-1)
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

const overlap = (merged: readonly [number, number][], from: number, to: number) =>
  merged.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0)

/**
 * Pure: per lab, incidents per month and how much of each month the copies
 * reach. `incidents` are already filtered to those the live feed counts. Months run from the first month any lab's copies reach (not before
 * ARCHIVE_FROM) to the month before the latest live lane began; a lab's
 * months from its own live start on are null.
 */
export function incidentArchiveSeries(
  incidents: readonly ArchivedIncidentStart[],
  copies: readonly StatusCopy[],
): Pick<IncidentArchiveView, 'months'> & { labs: Omit<IncidentArchiveLab, 'display'>[] } {
  const floor = Date.parse(ARCHIVE_FROM)
  const providers = [...new Set(STATUS_ARCHIVE_ERAS.map((e) => e.provider))]
  const reach = new Map<string, [number, number][]>()
  for (const p of providers) {
    const live = Date.parse(STATUS_LIVE_FROM[p])
    reach.set(
      p,
      union(
        copies
          .filter((c) => c.provider === p && c.status === 'parsed' && c.covers_from)
          .map((c): [number, number] => [
            Math.max(floor, Date.parse(c.covers_from!)),
            Math.min(live, Date.parse(c.captured_at)),
          ]),
      ),
    )
  }
  const firstReach = [...reach.values()].flatMap((r) => r.map(([a]) => a)).sort((a, b) => a - b)[0]
  const lastLive = providers
    .map((p) => STATUS_LIVE_FROM[p])
    .sort(byString)
    .at(-1)!
  const months: string[] = []
  if (firstReach !== undefined) {
    for (
      let m = monthOf(new Date(firstReach).toISOString());
      m < monthOf(lastLive);
      m = nextMonth(m)
    ) {
      months.push(m)
    }
  }

  const labs = providers.map((provider): Omit<IncidentArchiveLab, 'display'> => {
    const merged = reach.get(provider)!
    const liveFrom = STATUS_LIVE_FROM[provider]
    const mine = incidents.filter((i) => i.provider === provider)
    const perMonth = new Map<string, number>()
    for (const i of mine) {
      const m = monthOf(new Date(Date.parse(i.started_at)).toISOString())
      perMonth.set(m, (perMonth.get(m) ?? 0) + 1)
    }
    const covered = months.map((m) => {
      if (m >= monthOf(liveFrom)) return 0
      const from = monthStart(m)
      const to = monthStart(nextMonth(m))
      return Math.round((overlap(merged, from, to) / (to - from)) * 1000) / 1000
    })
    const holes: { from: string; until: string }[] = []
    let cursor = floor
    for (const [a, b] of [...merged, [Date.parse(liveFrom), Date.parse(liveFrom)] as const]) {
      if (a - cursor >= DAY_MS) {
        holes.push({
          from: new Date(cursor).toISOString().slice(0, 10),
          until: new Date(a).toISOString().slice(0, 10),
        })
      }
      cursor = Math.max(cursor, b)
    }
    const mineCopies = copies.filter((c) => c.provider === provider)
    const read = mineCopies
      .filter((c) => c.status === 'parsed')
      .map((c) => c.captured_at)
      .sort(byString)
    return {
      provider: provider as LabId,
      counts: months.map((m, i) => (covered[i]! > 0 ? (perMonth.get(m) ?? 0) : null)),
      covered,
      copies: read.length,
      skipped: mineCopies.length - read.length,
      incidents: mine.length,
      first_copy: read[0] ?? null,
      last_copy: read.at(-1) ?? null,
      holes,
      live_from: liveFrom.slice(0, 10),
      feeds: STATUS_ARCHIVE_ERAS.filter((e) => e.provider === provider).map((e) => ({
        url: e.url,
        archive_url: `https://web.archive.org/web/*/${e.url}`,
      })),
    }
  })
  return { months, labs }
}

/**
 * The archived incident history, or null before the backfill has stored
 * anything. `counts` is the live feed's own filter (terminal-incidents.ts),
 * passed in so this module needn't import the live query that calls it.
 */
export async function queryIncidentArchive(
  db: PipelineDb,
  counts: (components: readonly string[]) => boolean,
): Promise<IncidentArchiveView | null> {
  const [rows, copies] = await Promise.all([
    db
      .select({
        provider: tables.archivedIncidents.provider,
        started_at: tables.archivedIncidents.started_at,
        components: tables.archivedIncidents.components,
      })
      .from(tables.archivedIncidents),
    db
      .select({
        provider: tables.archiveCaptures.provider,
        status: tables.archiveCaptures.status,
        captured_at: tables.archiveCaptures.captured_at,
        covers_from: tables.archiveCaptures.covers_from,
      })
      .from(tables.archiveCaptures)
      .where(eq(tables.archiveCaptures.axis, 'status')),
  ])
  if (rows.length === 0) return null
  const incidents = rows
    .map((r) => ({
      ...r,
      components: (JSON.parse(r.components) as unknown[]).filter(
        (c): c is string => typeof c === 'string',
      ),
    }))
    .filter((i) => counts(i.components))
  const { months, labs } = incidentArchiveSeries(incidents, copies)
  const display = (p: LabId) => PROVIDER_DISPLAY[p]
  return {
    months,
    labs: labs.map((l) => ({ ...l, display: display(l.provider) })),
    gaps: STATUS_ARCHIVE_GAPS.map((g) => ({ ...g, display: display(g.provider) })),
    not_covered: STATUS_ARCHIVE_NOT_COVERED.map((n) => ({ ...n, display: display(n.provider) })),
    method: INCIDENT_ARCHIVE_METHOD,
  }
}
