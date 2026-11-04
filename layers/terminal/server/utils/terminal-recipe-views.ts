// The read side of the recipes audited on 2026-11-04: each query turns
// recipe_observations into one panel's payload (layers/terminal/shared/utils/recipe-views.ts).
// Every figure keeps the URL it was read from and when; a recipe with no
// stored rows yet yields an empty entry, never a guess.

import { inArray } from 'drizzle-orm'

import { companyName, type CompanyId } from '../../shared/utils/companies'
import {
  LAB_OF_NAME,
  humanizeConcept,
  type AdoptionData,
  type DataCentersData,
  type LimitRow,
  type LimitsData,
  type ParentFact,
  type ParentsData,
  type PayCell,
  type PayData,
  type RecipeCitation,
} from '../../shared/utils/recipe-views'
import type { LabId } from '../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '../pipeline/store'
import { EPOCH_DATA_CENTERS } from '../theses/recipes/epoch-data-centers'
import { GITHUB_AGENT_RECIPES } from '../theses/recipes/github-agent-prs'
import { INVESTEE_RECIPES } from '../theses/recipes/investee-facts'
import { NPM_LAB_RECIPES } from '../theses/recipes/npm-downloads'
import { PAY_RECIPES } from '../theses/recipes/pay-bands'
import { PYPI_LAB_RECIPES } from '../theses/recipes/pypi-downloads'
import { RAMP_AI_INDEX } from '../theses/recipes/ramp-ai-index'
import { RATE_LIMIT_RECIPES } from '../theses/recipes/rate-limits'

type Row = typeof tables.recipeObservations.$inferSelect

const DAY_MS = 86_400_000
const dayOf = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY_MS
const isLab = (c: CompanyId): c is LabId =>
  ['openai', 'anthropic', 'google', 'xai', 'meta', 'mistral'].includes(c)

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

// ── Adoption: Ramp, package downloads, coding-agent PRs ─────────────────────

export const RAMP_CAVEAT =
  'Share of US businesses on Ramp that spent anything with the vendor in the month, by card or bill pay. It measures adoption, not spend, and covers Ramp’s customers only. Ramp restates past months between releases. This is the newest release, and each earlier one is in the export. Google and Meta aren’t in Ramp’s vendor series.'
export const DOWNLOADS_CAVEAT =
  'Every download counts, including CI and bots. Days when npm’s stats were down read as zero. Watch the trend instead of the level, and don’t read downloads as users.'
export const AGENT_PRS_CAVEAT =
  'Public repositories only, one trend per agent. Each agent leaves a different trace (a default-on PR footer users can turn off, a bot author, a branch name), so the counts can’t be read as shares of one market.'

const AGENT_PACKAGES = new Set(['@anthropic-ai/claude-code', '@openai/codex', '@google/gemini-cli'])

function windowSums(points: readonly { date: string; value: number }[]) {
  const byDay = new Map(points.map((p) => [dayOf(p.date), p.value]))
  const last = points.reduce((m, p) => Math.max(m, dayOf(p.date)), -Infinity)
  const sum = (end: number) => {
    let s = 0
    for (let d = end - 27; d <= end; d++) {
      const v = byDay.get(d)
      if (v === undefined) return null
      s += v
    }
    return s
  }
  return Number.isFinite(last)
    ? {
        last_28d: sum(last),
        prior_28d: sum(last - 28),
        through: new Date(last * DAY_MS).toISOString().slice(0, 10),
      }
    : { last_28d: null, prior_28d: null, through: null }
}

export async function queryAdoption(db: PipelineDb): Promise<AdoptionData> {
  const pkgRecipes = [
    ...NPM_LAB_RECIPES.map((r) => ({ r, registry: 'npm' as const })),
    ...PYPI_LAB_RECIPES.map((r) => ({ r, registry: 'PyPI' as const })),
  ]
  const ids = [
    RAMP_AI_INDEX.id,
    ...pkgRecipes.map((p) => p.r.id),
    ...GITHUB_AGENT_RECIPES.map((r) => r.id),
  ]
  const rows = await rowsOf(db, ids)
  const of = (id: string) => rows.filter((r) => r.recipe_id === id)

  const rampRows = of(RAMP_AI_INDEX.id)
  const current = rampRows.filter((r) => !r.key.includes('@') && r.value !== null)
  let ramp: AdoptionData['ramp'] = null
  const newestRamp = newestRow(current)
  if (newestRamp) {
    const months = [...new Set(current.map((r) => r.date))].sort()
    const keys = [...new Set(current.map((r) => r.key))]
    const at = new Map(current.map((r) => [`${r.key}|${r.date}`, r]))
    const latest = (k: string) => at.get(`${k}|${months.at(-1)}`)?.value ?? -1
    const series = keys
      .sort((a, b) => (a === 'overall' ? -1 : b === 'overall' ? 1 : latest(b) - latest(a)))
      .map((key) => {
        const any = current.find((r) => r.key === key)!
        const vendor = payloadOf(any).vendor
        return {
          key,
          label: key === 'overall' ? 'Any AI vendor' : typeof vendor === 'string' ? vendor : key,
          lab: LAB_OF_NAME[key] ?? null,
          values: months.map((m) => at.get(`${key}|${m}`)?.value ?? null),
        }
      })
    const releases = rampRows.map((r) => r.key.split('@')[1]).filter((d): d is string => Boolean(d))
    const version = payloadOf(newestRamp).data_version
    ramp = {
      months,
      series,
      release_seen: releases.sort().at(-1) ?? newestRamp.first_seen_at.slice(0, 10),
      data_version: typeof version === 'string' ? version : null,
      source: cite(RAMP_AI_INDEX.id, 'Ramp AI Index', newestRamp),
    }
  }

  const downloads = pkgRecipes.flatMap(({ r, registry }) => {
    if (!isLab(r.company)) return []
    const rs = of(r.id).filter((x) => x.value !== null)
    const pkg =
      rs[0]?.key ?? /\/([^/]+)\/?$/.exec(r.url({ now: new Date(), newest: null }))?.[1] ?? r.id
    const newest = newestRow(rs)
    return [
      {
        recipe_id: r.id,
        lab: r.company,
        registry,
        package: pkg,
        kind: AGENT_PACKAGES.has(pkg) ? ('agent' as const) : ('sdk' as const),
        ...windowSums(rs.map((x) => ({ date: x.date, value: x.value! }))),
        source: newest ? cite(r.id, `${registry} ${pkg}`, newest) : null,
      },
    ]
  })

  const agent_prs = GITHUB_AGENT_RECIPES.flatMap((r) => {
    if (!isLab(r.company)) return []
    const rs = of(r.id).filter((x) => x.value !== null)
    const newest = newestRow(rs)
    const agent = rs[0]?.key ?? r.description.replace(/^.* from (.+?) \(search.*$/, '$1')
    return [
      {
        recipe_id: r.id,
        lab: r.company,
        agent,
        query: /\(search: (.*)\)$/.exec(r.description)?.[1] ?? '',
        days: rs
          .map((x) => ({ date: x.date, value: x.value! }))
          .sort((a, b) => (a.date < b.date ? -1 : 1)),
        source: newest ? cite(r.id, `GitHub search: ${agent}`, newest) : null,
      },
    ]
  })

  return {
    as_of: asOf(rows),
    ramp,
    downloads,
    agent_prs,
    caveats: { ramp: RAMP_CAVEAT, downloads: DOWNLOADS_CAVEAT, agent_prs: AGENT_PRS_CAVEAT },
  }
}

// ── Rate limits ─────────────────────────────────────────────────────────────

export const LIMITS_CAVEAT =
  'The limits each lab publishes in its docs. They reflect tier design and abuse control as much as capacity, and they change in announced steps. We store a new reading only when a limit changes. Google and Mistral publish no per-model limits.'

function snapshotRows(rows: readonly Row[]): { metrics: string[]; rows: LimitRow[] } {
  const metrics: string[] = []
  const grouped = new Map<string, LimitRow>()
  for (const r of rows) {
    const p = payloadOf(r) as { model?: string; tier?: string; metric?: string; text?: string }
    const model = p.model ?? r.key.split('|')[0]!
    const tier = p.tier ?? r.key.split('|')[1]!
    const metric = p.metric ?? r.key.split('|')[2]!
    const id = `${model}|${tier}`
    const row = grouped.get(id) ?? { model, tier, values: {}, text: null }
    if (metric === 'other') row.text = p.text ?? null
    else {
      if (!metrics.includes(metric)) metrics.push(metric)
      row.values[metric] = r.value
    }
    grouped.set(id, row)
  }
  return { metrics, rows: [...grouped.values()] }
}

export async function queryLimits(db: PipelineDb): Promise<LimitsData> {
  const rows = await rowsOf(
    db,
    RATE_LIMIT_RECIPES.map((r) => r.id),
  )
  const pages = RATE_LIMIT_RECIPES.flatMap((recipe) => {
    if (!isLab(recipe.company)) return []
    const rs = rows.filter((r) => r.recipe_id === recipe.id)
    const dates = [...new Set(rs.map((r) => r.date))].sort()
    const snapshot = dates.at(-1)
    if (!snapshot) return []
    const now = rs.filter((r) => r.date === snapshot)
    const previous = dates.at(-2) ?? null
    const before = new Map(rs.filter((r) => r.date === previous).map((r) => [r.key, r.value]))
    const changed = previous ? now.filter((r) => before.get(r.key) !== r.value).length : 0
    return [
      {
        recipe_id: recipe.id,
        lab: recipe.company,
        covers: recipe.description.replace(/^Published API rate limits: /, ''),
        ...snapshotRows(now),
        snapshot,
        previous,
        changed,
        source: cite(recipe.id, `${companyName(recipe.company)} rate limits`, newestRow(now)!),
      },
    ]
  })
  return { as_of: asOf(rows), pages, caveat: LIMITS_CAVEAT }
}

// ── Posted pay ──────────────────────────────────────────────────────────────

export const PAY_CAVEAT =
  'The median midpoint of each posted US annual salary band. Bands are posted ranges, not offers, and leave out equity, which is the larger part of pay at these labs. We map departments by hand for each board and leave out sales (Anthropic posts on-target earnings, OpenAI base pay). So compare each cell with itself over time instead of comparing labs. xAI and Mistral post no usable pay.'

const PAY_LABELS: Record<string, string> = {
  all: 'All roles',
  research: 'Research',
  swe: 'Software engineering',
}

export async function queryPay(db: PipelineDb): Promise<PayData> {
  const rows = await rowsOf(
    db,
    PAY_RECIPES.map((r) => r.id),
  )
  const boards = PAY_RECIPES.flatMap((recipe) => {
    if (!isLab(recipe.company)) return []
    const rs = rows.filter((r) => r.recipe_id === recipe.id && r.value !== null)
    const dates = [...new Set(rs.map((r) => r.date))].sort()
    const date = dates.at(-1)
    if (!date) return []
    const previous = dates.at(-2) ?? null
    const now = rs.filter((r) => r.date === date)
    const cells: PayCell[] = now.map((r) => {
      const p = payloadOf(r) as {
        n: number
        p25: number
        p75: number
        departments: string[] | null
      }
      const prev = previous ? rs.find((x) => x.date === previous && x.key === r.key) : undefined
      return {
        key: r.key,
        label: PAY_LABELS[r.key] ?? r.key,
        median: r.value!,
        p25: p.p25,
        p75: p.p75,
        n: p.n,
        departments: p.departments,
        previous: prev ? { date: prev.date, median: prev.value! } : null,
      }
    })
    const roles = (payloadOf(now[0]!) as { roles_on_board?: number }).roles_on_board ?? 0
    return [
      {
        recipe_id: recipe.id,
        lab: recipe.company,
        date,
        roles_on_board: roles,
        cells: cells.sort(
          (a, b) => Object.keys(PAY_LABELS).indexOf(a.key) - Object.keys(PAY_LABELS).indexOf(b.key),
        ),
        source: cite(recipe.id, `${companyName(recipe.company)} job board`, newestRow(now)!),
      },
    ]
  })
  return { as_of: asOf(rows), boards, caveat: PAY_CAVEAT }
}

// ── Parents' filings ────────────────────────────────────────────────────────

export const PARENTS_CAVEAT =
  'The parent’s own figures from its newest 10-Q or 10-K. None of them are the lab’s. Microsoft accounts for OpenAI at hypothetical liquidation value and books dilution gains in the same line, so dividing by the stake doesn’t give OpenAI’s result. Amazon’s marks follow observable prices, and 12% is a cap instead of a stake, so none of this is Anthropic’s valuation.'

const CONCEPT_LABELS: Record<string, string> = {
  NonoperatingIncomeExpense: 'Gain or loss recognized (other income)',
  EquityMethodInvestmentOwnershipPercentage: 'Stake',
  RevenueFromContractWithCustomerExcludingAssessedTax: 'Revenue from the lab',
  AccountsReceivableNet: 'Receivables from the lab',
  EquityMethodInvestmentsTotalFundingCommitments: 'Funding committed',
  EquityMethodInvestmentsFunded: 'Funding paid in',
  RevenueRemainingPerformanceObligationAmountPeriodIncreaseDecrease:
    'Remaining performance obligation added',
  RevenueRemainingPerformanceObligationExpectedTimingOfSatisfactionPeriod1:
    'Period that obligation is expected to be satisfied over',
  LineOfCreditFacilityMaximumBorrowingCapacity: 'Credit facility to the lab, maximum',
  LineOfCreditFacilityCurrentBorrowingCapacity: 'Credit facility to the lab, available now',
  LineOfCreditFacilityExpirationPeriod: 'Credit facility term',
  EquitySecuritiesWithoutReadilyDeterminableFairValueUpwardPriceAdjustmentAnnualAmount:
    'Upward adjustments to the investment',
  InvestmentOwnedBalanceShares: 'Preferred shares held',
}

const PARENT_OF: Record<string, { parent: string; member: string }> = {
  'sec-msft-openai': { parent: 'Microsoft', member: 'msft:OpenAIGlobalLlcMember' },
  'sec-amzn-anthropic': { parent: 'Amazon', member: 'amzn:AnthropicMember' },
}

function unitOf(p: { unit?: string | null; text?: string }, concept: string): ParentFact['unit'] {
  if (p.text !== undefined) return 'text'
  const u = (p.unit ?? '').toLowerCase()
  if (u.includes('usd')) return 'usd'
  if (u.includes('pure') || /Percentage$/.test(concept)) return 'pure'
  return 'shares'
}

export async function queryParents(db: PipelineDb): Promise<ParentsData> {
  const rows = await rowsOf(
    db,
    INVESTEE_RECIPES.map((r) => r.id),
  )
  const parents = INVESTEE_RECIPES.flatMap((recipe) => {
    if (!isLab(recipe.company)) return []
    const rs = rows.filter((r) => r.recipe_id === recipe.id)
    const newest = newestRow(rs)
    if (!newest) return []
    // The newest filing's facts only: its own comparatives ride along.
    const filing = rs.filter((r) => r.source_url === newest.source_url)
    const facts: ParentFact[] = filing
      .map((r) => {
        const p = payloadOf(r) as {
          concept?: string
          unit?: string | null
          text?: string
          start?: string | null
        }
        const [concept = r.key, ...rest] = r.key.split('|')
        const span = rest.at(-1) ?? 'instant'
        const qualifier =
          rest.length > 1 ? ` (${rest.slice(0, -1).join(', ').replace(/=/g, ': ')})` : ''
        return {
          key: r.key,
          label: (CONCEPT_LABELS[concept] ?? humanizeConcept(concept)) + qualifier,
          date: r.date,
          span: span === 'instant' ? 'instant' : `${span.replace(/m$/, '')} months`,
          value: r.value,
          unit: unitOf(p, concept),
          text: p.text ?? null,
        }
      })
      .sort((a, b) =>
        a.date === b.date ? a.label.localeCompare(b.label) : a.date < b.date ? 1 : -1,
      )
    return [
      {
        recipe_id: recipe.id,
        lab: recipe.company,
        ...PARENT_OF[recipe.id]!,
        period: facts.reduce((m, f) => (f.date > m ? f.date : m), ''),
        facts,
        source: cite(recipe.id, `${PARENT_OF[recipe.id]!.parent} XBRL instance`, newest),
      },
    ]
  })
  return { as_of: asOf(rows), parents, caveat: PARENTS_CAVEAT }
}

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

/** Every recipe the views read, for the cache key. */
export const VIEW_RECIPES = {
  adoption: [RAMP_AI_INDEX, ...NPM_LAB_RECIPES, ...PYPI_LAB_RECIPES, ...GITHUB_AGENT_RECIPES].map(
    (r) => r.id,
  ),
  limits: RATE_LIMIT_RECIPES.map((r) => r.id),
  pay: PAY_RECIPES.map((r) => r.id),
  parents: INVESTEE_RECIPES.map((r) => r.id),
  datacenters: [EPOCH_DATA_CENTERS.id],
} as const
