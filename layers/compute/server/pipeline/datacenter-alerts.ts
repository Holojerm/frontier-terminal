// The data-center rule: when Epoch AI's newest snapshot of its data-center dataset differs from
// the one before in a way a reader would quote, one alert per site cites both reads. No model in
// the loop.
//
//   a new site of NEW_SITE_MW or more (a name the earlier snapshot did not have)
//   a site whose current power moves MOVE_PCT and MOVE_MW or more
//
// Only the newest snapshot against the one before is read, and only when it is under FRESH_DAYS
// old, so a first run over stored history alerts on nothing. Ids hash (site, snapshot date), so a
// re-run writes nothing twice. A site that vanishes is not alerted: Epoch renames and merges
// sites, so a removal is as likely an edit as an event. An added site whose power matches a site
// removed in the same step is a rename and is skipped too.

import { inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/utils/pipeline-store'
import {
  writeFindings,
  type Finding,
} from '#layers/core/server/pipeline/observation-alerts'
import type { Provider } from '#layers/core/server/utils/contracts'
import { attributedLabs } from '../power/sites'
import { EPOCH_DATA_CENTERS } from '../recipes/epoch-data-centers'

export const DATACENTER_RULE = 'datacenter-floor' as const

export const NEW_SITE_MW = 100
export const MOVE_PCT = 25
export const MOVE_MW = 50
/** An added site this close in power to a removed one is a rename. */
const RENAME_TOLERANCE = 0.1
const FRESH_DAYS = 7
const DAY_MS = 86_400_000

type Row = typeof tables.recipeObservations.$inferSelect

interface Site {
  name: string
  mw: number
  h100e: number | null
  owner: string
  users: string
  country: string
  source_url: string
  fetched_at: string
}

const readSite = (r: Row): Site => {
  const p = JSON.parse(r.payload) as Partial<Site> & { h100e?: number | null }
  return {
    name: r.key,
    mw: r.value!,
    h100e: p.h100e ?? null,
    owner: p.owner ?? '',
    users: p.users ?? '',
    country: p.country ?? '',
    source_url: r.source_url,
    fetched_at: r.fetched_at,
  }
}

export type SiteChange =
  | { kind: 'new'; site: Site }
  | { kind: 'power'; site: Site; before: number; pct: number }

/** Pure: what changed between two snapshots (each one site per name) that is worth an alert. */
export function siteChanges(earlier: readonly Site[], later: readonly Site[]): SiteChange[] {
  const was = new Map(earlier.map((s) => [s.name, s]))
  const is = new Set(later.map((s) => s.name))
  const gone = earlier.filter((s) => !is.has(s.name))
  const out: SiteChange[] = []
  for (const s of later) {
    const before = was.get(s.name)
    if (!before) {
      const renamed = gone.some((g) => Math.abs(g.mw - s.mw) <= g.mw * RENAME_TOLERANCE)
      if (s.mw >= NEW_SITE_MW && !renamed) out.push({ kind: 'new', site: s })
    } else if (before.mw > 0) {
      const pct = ((s.mw - before.mw) / before.mw) * 100
      if (Math.abs(pct) >= MOVE_PCT && Math.abs(s.mw - before.mw) >= MOVE_MW) {
        out.push({ kind: 'power', site: s, before: before.mw, pct })
      }
    }
  }
  return out
}

const mw = (n: number) => `${Math.round(n * 10) / 10} MW`
const providerOf = (s: Site): Provider => {
  const labs = attributedLabs(s.users)
  return labs.length === 1 ? labs[0]! : 'other'
}

const CAVEAT =
  'Epoch AI’s estimates (CC BY 4.0): 80% of power estimates fall within a factor of 1.4, and a change can be a revised estimate as much as a build.'

/** One finding for a change, from the snapshot dates it sits between. */
export function siteFinding(
  c: SiteChange,
  dates: { earlier: string; later: string },
): Finding {
  const s = c.site
  const owner = s.owner ? ` Owner: ${s.owner}.` : ''
  const users = s.users ? ` Users: ${s.users}.` : ''
  const where = s.country ? ` in ${s.country}` : ''
  const common = {
    rule: DATACENTER_RULE,
    entity_type: 'data_center' as const,
    entity_key: `data_center:${s.name}`,
    provider: providerOf(s),
    period: dates.later,
    source_url: s.source_url,
    fetched_at: s.fetched_at,
  }
  const after = {
    site: s.name,
    summary: `${s.name} data center · ${mw(s.mw)} · ${dates.later}`,
    as_of: dates.later,
    power_mw: s.mw,
    h100e: s.h100e === null ? null : Math.round(s.h100e),
    owner: s.owner,
    users: s.users,
  }
  if (c.kind === 'new') {
    return {
      ...common,
      change_type: 'added',
      before: null,
      after,
      headline: `Epoch AI adds a ${mw(s.mw)} data center${where}: ${s.name}`,
      explanation: [
        `Epoch AI’s data-center dataset of ${dates.later} lists ${s.name}${where} at ${mw(s.mw)} of current power, and its read of ${dates.earlier} did not.${owner}${users}`,
        CAVEAT,
        `Rule-based: a site of ${NEW_SITE_MW} MW or more that the earlier snapshot didn’t have, and no removed site of about the same power (a rename). No model in the loop.`,
      ].join(' '),
    }
  }
  const verb = c.pct > 0 ? 'raises' : 'cuts'
  return {
    ...common,
    change_type: 'modified',
    before: {
      site: s.name,
      summary: `${s.name} data center · ${mw(c.before)} · ${dates.earlier}`,
      as_of: dates.earlier,
      power_mw: c.before,
    },
    after: { ...after, pct_change: Math.round(c.pct * 100) / 100 },
    headline: `Epoch AI ${verb} ${s.name} to ${mw(s.mw)} from ${mw(c.before)} (${Math.round(Math.abs(c.pct))}%)`,
    explanation: [
      `Epoch AI’s dataset put ${s.name}${where} at ${mw(c.before)} of current power on ${dates.earlier} and ${mw(s.mw)} on ${dates.later} (${Math.round(c.pct * 10) / 10}%).${owner}${users}`,
      CAVEAT,
      `Rule-based: current power moving ${MOVE_PCT}% and ${MOVE_MW} MW or more between two snapshots. No model in the loop.`,
    ].join(' '),
  }
}

/** Pure: the findings between the newest snapshot and the one before it, if the newest is fresh. */
export function datacenterFindings(rows: readonly Row[], now: Date): Finding[] {
  const dated = rows.filter((r) => r.value !== null)
  const dates = [...new Set(dated.map((r) => r.date))].sort()
  const later = dates.at(-1)
  const earlier = dates.at(-2)
  if (!later || !earlier) return []
  if (now.getTime() - Date.parse(`${later}T00:00:00Z`) > FRESH_DAYS * DAY_MS) return []
  const at = (d: string) => dated.filter((r) => r.date === d).map(readSite)
  return siteChanges(at(earlier), at(later)).map((c) => siteFinding(c, { earlier, later }))
}

interface DatacenterAlertReport {
  written: number
  findings: number
}

export async function writeDatacenterAlerts(
  db: PipelineDb,
  now = new Date(),
): Promise<DatacenterAlertReport> {
  const rows = await db
    .select()
    .from(tables.recipeObservations)
    .where(inArray(tables.recipeObservations.recipe_id, [EPOCH_DATA_CENTERS.id]))
  const findings = datacenterFindings(rows, now)
  return { written: await writeFindings(db, findings, now), findings: findings.length }
}
