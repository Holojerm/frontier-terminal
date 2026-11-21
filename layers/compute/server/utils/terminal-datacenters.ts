// The read side of Epoch AI's data-center recipes: each query turns
// recipe_observations into one panel's payload (compute-views.ts and
// power-sites.ts in this layer's shared/utils). Every figure keeps the URL it
// was read from and when; a recipe with no stored rows yet yields an empty
// entry, never a guess.

import { inArray } from 'drizzle-orm'

import { LAB_OF_NAME } from '#layers/core/shared/utils/lab-names'
import type { LabId, RecipeCitation } from '#layers/core/shared/utils/terminal-types/common'
import type { DataCentersData } from '../../shared/utils/compute-views'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import type {
  PowerBasis,
  PowerGrid,
  PowerLink,
  PowerRole,
  PowerSite,
  PowerSiteGap,
  PowerSitesData,
  PowerTicker,
  PowerUncovered,
} from '../../shared/utils/power-sites'
import { pendingDocuments as pendingPowerDocuments } from '../power/ingest'
import { attributedLabs } from '../power/sites'
import { currentTies, type StoredTie } from '../power/store'
import { EPOCH_DATA_CENTERS, EPOCH_DATA_CENTER_TIMELINES } from '../recipes/epoch-data-centers'

type Row = typeof tables.recipeObservations.$inferSelect

async function rowsOf(db: PipelineDb, ids: readonly string[]): Promise<Row[]> {
  if (ids.length === 0) return []
  return db
    .select()
    .from(tables.recipeObservations)
    .where(inArray(tables.recipeObservations.recipe_id, [...ids]))
}

const payloadOf = (r: Row): Record<string, unknown> =>
  JSON.parse(r.payload) as Record<string, unknown>

function newestRow(rows: readonly Row[]): Row | null {
  return rows.reduce<Row | null>((a, b) => (!a || b.fetched_at > a.fetched_at ? b : a), null)
}

function cite(recipe_id: string, label: string, r: Row): RecipeCitation {
  return { recipe_id, label, source_url: r.source_url, fetched_at: r.fetched_at }
}

const asOf = (rows: readonly Row[]) => newestRow(rows)?.fetched_at ?? null

// ── Data-center power (Epoch AI) ────────────────────────────────────────────

export const DATACENTERS_CAVEAT =
  'Epoch AI’s estimates (CC BY 4.0). 80% of power estimates fall within a factor of 1.4, and coverage starts with sites operational in 2024 or later. A site counts in full for every lab Epoch names as a user at #confident or #likely. So a shared site (Colossus 2, used by Anthropic and SpaceXAI) counts for each, and the labs don’t add up to the total.'

const ATTRIBUTED = /#(confident|likely)\b/

export async function queryDataCenters(db: PipelineDb): Promise<DataCentersData> {
  const rows = (await rowsOf(db, [EPOCH_DATA_CENTERS.id])).filter((r) => r.value !== null)
  const snapshot = rows.reduce((m, r) => (r.date > m ? r.date : m), '')
  const now = rows.filter((r) => r.date === snapshot)
  const labs = new Map<LabId, DataCentersData['labs'][number]>()
  const speculative = new Set<LabId>()
  for (const r of now) {
    for (const u of String(payloadOf(r).users ?? '').split(',')) {
      const lab = LAB_OF_NAME[u.replace(/#\w+/g, '').trim().toLowerCase().replace(/\s+/g, '-')]
      if (lab && /#speculative\b/.test(u)) speculative.add(lab)
    }
    const p = payloadOf(r) as { users?: string; h100e?: number | null }
    const users = (p.users ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter((u) => ATTRIBUTED.test(u))
      .map((u) => u.replace(/#\w+/g, '').trim())
    const named = [
      ...new Set(users.map((u) => LAB_OF_NAME[u.toLowerCase().replace(/\s+/g, '-')] ?? null)),
    ]
    for (const lab of named) {
      if (!lab) continue
      const e = labs.get(lab) ?? { lab, mw: 0, h100e: 0, sites: 0, shared: 0, names: [] }
      e.mw += r.value!
      e.h100e += p.h100e ?? 0
      e.sites += 1
      if (users.length > 1) e.shared += 1
      e.names.push(r.key)
      labs.set(lab, e)
    }
  }
  const mwOf = new Map(now.map((r) => [r.key, r.value!]))
  const newest = newestRow(now)
  return {
    as_of: asOf(rows),
    snapshot: snapshot || null,
    sites: now.length,
    total_mw: now.reduce((n, r) => n + r.value!, 0),
    total_h100e: now.reduce((n, r) => n + ((payloadOf(r).h100e as number | null) ?? 0), 0),
    labs: [...labs.values()]
      .map((e) => ({
        ...e,
        names: e.names.sort((a, b) => (mwOf.get(b) ?? 0) - (mwOf.get(a) ?? 0)),
      }))
      .sort((a, b) => b.mw - a.mw),
    speculative_only: [...speculative].filter((l) => !labs.has(l)).sort(),
    site_list: now
      .map((r) => {
        const p = payloadOf(r) as {
          h100e?: number | null
          owner?: string
          users?: string
          country?: string
        }
        return {
          name: r.key,
          mw: r.value!,
          h100e: p.h100e ?? null,
          owner: p.owner ?? '',
          users: p.users ?? '',
          country: p.country ?? '',
        }
      })
      .sort((a, b) => b.mw - a.mw),
    source: newest ? cite(EPOCH_DATA_CENTERS.id, 'Epoch AI, AI data centers', newest) : null,
    caveat: DATACENTERS_CAVEAT,
  }
}

// ── Who powers the lab sites (Epoch AI's sites, our companies from D1) ──────

export const POWER_SITES_CAVEAT =
  'The sites, their power and their users are Epoch AI’s estimates (CC BY 4.0). The companies are ours. Each is read from the page cited beside it, which is a filing, a regulator’s page or the company’s own. We read the first ones by hand. When a new SEC filing names a site, a model reads it, and we keep a row only where the quote, the company, the site and any megawatt figure are in the filing word for word. We matched each company to its listed parent and ticker ourselves. A row ties a company to a site. It doesn’t say how much of the site’s power that company supplies.'

/** What the table never reads, whatever Epoch adds. */
const POWER_STANDING_GAPS: PowerSiteGap[] = [
  {
    id: 'pages-off-edgar',
    site: null,
    title: 'New utility, regulator and company pages are read by hand',
    reason:
      'We search new SEC filings for each site every day. A utility’s release, a regulator’s order or a company’s own page we find and read by hand. We re-read each one we cite every week. If its quote is gone, we flag it, and the row keeps the date we last saw it.',
  },
  {
    id: 'outside-sec',
    site: null,
    title: 'Sites whose power companies don’t file with the SEC wait for a hand read',
    reason:
      'A site in Europe, the Gulf or Asia is powered by companies that file nothing with the SEC. It waits until we read a regulator’s or a company’s page by hand.',
  },
]

/** Epoch's rows to the companies stored for each site: the grid where one is named, then each link. */
function storedSites(rows: StoredTie[]) {
  const bySite = new Map<string, { grid: PowerGrid | null; links: PowerLink[] }>()
  for (const r of rows) {
    const e = bySite.get(r.site) ?? { grid: null, links: [] }
    if (r.role === 'grid') {
      e.grid ??= {
        name: r.company_name,
        source_url: r.source_url,
        quote: r.quote,
        fetched_at: r.fetched_at,
      }
    } else {
      e.links.push({
        role: r.role as PowerRole,
        company: r.company_name,
        parent: r.parent,
        ticker: r.ticker,
        unlisted: r.unlisted,
        mw: r.mw,
        mw_meaning: r.mw_meaning,
        source_url: r.source_url,
        source_title: r.source_title ?? '',
        publisher: r.publisher ?? '',
        published: r.published,
        quote: r.quote,
        fetched_at: r.fetched_at,
        basis: r.basis as PowerBasis,
      })
    }
    bySite.set(r.site, e)
  }
  return bySite
}

export async function queryPowerSites(db: PipelineDb): Promise<PowerSitesData> {
  const [rows, ties, waiting] = await Promise.all([
    rowsOf(db, [EPOCH_DATA_CENTERS.id, EPOCH_DATA_CENTER_TIMELINES.id]),
    currentTies(db),
    pendingPowerDocuments(db),
  ])
  const observed = rows.filter((r) => r.value !== null)
  const read = storedSites(ties)
  const pending = new Map<string, number>()
  for (const d of waiting) pending.set(d.site, (pending.get(d.site) ?? 0) + 1)
  const current = observed.filter((r) => r.recipe_id === EPOCH_DATA_CENTERS.id)
  const snapshot = current.reduce((m, r) => (r.date > m ? r.date : m), '')
  // Epoch's furthest dated estimate per site. One dated after the snapshot is a projection.
  const furthest = new Map<string, Row>()
  for (const r of observed) {
    if (r.recipe_id !== EPOCH_DATA_CENTER_TIMELINES.id) continue
    const f = furthest.get(r.key)
    if (!f || r.date > f.date) furthest.set(r.key, r)
  }

  const sites: PowerSite[] = []
  const uncovered: PowerUncovered[] = []
  for (const r of current.filter((c) => c.date === snapshot)) {
    const p = payloadOf(r) as { owner?: string; users?: string; country?: string }
    const labs = attributedLabs(p.users ?? '')
    if (labs.length === 0) continue
    const plan = furthest.get(r.key)
    const projected = plan && plan.date > snapshot ? plan : null
    const mine = read.get(r.key)
    if (!mine || mine.links.length === 0) {
      uncovered.push({
        name: r.key,
        labs,
        mw_now: r.value!,
        mw_planned: projected?.value ?? null,
        planned_date: projected?.date ?? null,
        pending: pending.get(r.key) ?? 0,
      })
      continue
    }
    sites.push({
      name: r.key,
      labs,
      owner: p.owner ?? '',
      users: p.users ?? '',
      country: p.country ?? '',
      mw_now: r.value!,
      mw_planned: projected?.value ?? null,
      planned_date: projected?.date ?? null,
      grid: mine.grid,
      links: mine.links,
    })
  }
  sites.sort((a, b) => b.mw_now - a.mw_now || (b.mw_planned ?? 0) - (a.mw_planned ?? 0))
  uncovered.sort((a, b) => b.mw_now - a.mw_now || a.name.localeCompare(b.name))

  const tickers = new Map<string, PowerTicker>()
  for (const s of sites) {
    // A site counts once per ticker, however many of its links name the company.
    const seen = new Set<string>()
    for (const l of s.links) {
      if (!l.ticker) continue
      const t = tickers.get(l.ticker) ?? {
        ticker: l.ticker,
        company: l.parent ?? l.company,
        roles: [],
        sites: [],
        labs: [],
      }
      if (!t.roles.includes(l.role)) t.roles.push(l.role)
      if (!seen.has(l.ticker)) {
        seen.add(l.ticker)
        t.sites.push(s.name)
        t.labs = [...new Set([...t.labs, ...s.labs])]
      }
      tickers.set(l.ticker, t)
    }
  }

  const newest = newestRow(current)
  return {
    as_of: asOf(observed),
    snapshot: snapshot || null,
    sites,
    tickers: [...tickers.values()].sort(
      (a, b) => b.sites.length - a.sites.length || a.ticker.localeCompare(b.ticker),
    ),
    uncovered,
    gaps: [...uncovered.map(uncoveredGap), ...POWER_STANDING_GAPS],
    source: newest ? cite(EPOCH_DATA_CENTERS.id, 'Epoch AI, AI data centers', newest) : null,
    caveat: POWER_SITES_CAVEAT,
  }
}

/** One uncovered site's gap: what Epoch says of it, and what is waiting to be read. */
function uncoveredGap(u: PowerUncovered): PowerSiteGap {
  const mw = `${Math.round(u.mw_now).toLocaleString('en-US')} MW`
  const waiting =
    u.pending === 0
      ? 'No filing, regulator’s page or company page we have read names its utility, generator or host yet.'
      : `${u.pending} SEC ${u.pending === 1 ? 'filing names it and waits' : 'filings name it and wait'} to be read.`
  return {
    id: `site:${u.name}`,
    site: u.name,
    title: `${u.name}: no power company read yet`,
    reason: `Epoch AI puts it at ${mw} now. ${waiting}`,
  }
}

/** Every recipe the views read, for the cache key. */
export const DATACENTER_RECIPES = {
  datacenters: [EPOCH_DATA_CENTERS.id],
  powerSites: [EPOCH_DATA_CENTERS.id, EPOCH_DATA_CENTER_TIMELINES.id],
} as const
