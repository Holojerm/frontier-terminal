// The read side of the recipes audited on 2026-11-04: each query turns
// recipe_observations into one panel's payload (layers/terminal/shared/utils/recipe-views.ts;
// Epoch AI's data centers are the compute layer's, terminal-datacenters.ts,
// the rate limits the pricing layer's, terminal-limits.ts, and posted pay the
// talent layer's, terminal-pay.ts).
// Every figure keeps the URL it was read from and when; a recipe with no
// stored rows yet yields an empty entry, never a guess.

import { inArray } from 'drizzle-orm'

import type { CompanyId } from '#layers/core/shared/utils/companies'
import {
  humanizeConcept,
  type AdoptionData,
  type AgentPrWeek,
  type ParentFact,
  type ParentsData,
} from '../../shared/utils/recipe-views'
import { LAB_OF_NAME } from '#layers/core/shared/utils/lab-names'
import type { RecipeCitation } from '#layers/core/shared/utils/terminal-types/common'
import type { LabId } from '../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import { PROVIDER_ORDER } from '#layers/core/server/utils/terminal-sources'
import { GITHUB_AGENT_RECIPES } from '../theses/recipes/github-agent-prs'
import { INVESTEE_RECIPES } from '../theses/recipes/investee-facts'
import {
  CONTROL_BASE,
  CONTROL_INDEX_ID,
  DOWNLOAD_SERIES,
  deriveDownloadSeries,
  dayRows,
  normalizedId,
  shareId,
  trailingRatio,
  weeklyRatio,
  type SeriesPoint,
} from '../theses/download-series'
import { NPM_CONTROL_RECIPES, NPM_LAB_RECIPES } from '../theses/recipes/npm-downloads'
import { PYPI_LAB_RECIPES } from '../theses/recipes/pypi-downloads'
import { RAMP_AI_INDEX } from '../theses/recipes/ramp-ai-index'
import { LIMIT_RECIPE_IDS } from '#layers/pricing/server/utils/terminal-limits'
import { PAY_RECIPE_IDS } from '#layers/talent/server/utils/terminal-pay'

type Row = typeof tables.recipeObservations.$inferSelect

const DAY_MS = 86_400_000
const dayOf = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY_MS
const isLab = (c: CompanyId): c is LabId => (PROVIDER_ORDER as readonly string[]).includes(c)

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
  'Every download counts, including CI and bots. Days when npm’s stats were down are left out, so a week with one is partial. Watch the trend instead of the level, and don’t read downloads as users.'
export const NORMALIZED_CAVEAT =
  'Divided by the median of react, typescript, express, lodash and axios, each against its own June 2025 average. That cancels swings across all of npm. It doesn’t cancel growth AI coding brings to every package.'
export const SHARE_CAVEAT =
  'Each lab’s main SDK against the other tracked labs’ main SDKs on the same registry. The openai package also calls other labs’ OpenAI-compatible APIs, so it overstates OpenAI.'
export const AGENT_PRS_CAVEAT =
  'Public repositories only, one trend per agent. Each agent leaves a different trace (a default-on PR footer users can turn off, a bot author, a branch name), so the counts can’t be read as shares of one market. Days before we started counting were counted later, from the pull requests that still existed then. Those rows are marked retrospective.'

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

/**
 * Pure: per-ISO-week sums (Monday to Sunday, UTC), oldest week first, through
 * the newest week whose Sunday is on record, so the week still running never
 * reads as a drop. A week missing any day is partial: its total covers only
 * the days present. A week is retrospective when any of its days is.
 */
export function weeklySums(
  points: readonly { date: string; value: number; retrospective?: boolean }[],
): AgentPrWeek[] {
  const byDay = new Map<number, { value: number; retrospective: boolean }>()
  let last = -Infinity
  for (const p of points) {
    const d = dayOf(p.date)
    byDay.set(d, { value: p.value, retrospective: p.retrospective === true })
    if (d > last) last = d
  }
  // Day 0 (1970-01-01) was a Thursday, so (d + 3) % 7 is days since Monday.
  const mondayOf = (d: number) => d - ((d + 3) % 7)
  const weeks = new Map<number, { days: number; total: number; retrospective: boolean }>()
  for (const [d, v] of byDay) {
    const monday = mondayOf(d)
    if (monday + 6 > last) continue
    const w = weeks.get(monday) ?? { days: 0, total: 0, retrospective: false }
    w.days++
    w.total += v.value
    w.retrospective ||= v.retrospective
    weeks.set(monday, w)
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([monday, w]) => ({
      week: new Date(monday * DAY_MS).toISOString().slice(0, 10),
      days: w.days,
      total: w.total,
      partial: w.days < 7,
      retrospective: w.retrospective,
    }))
}

export async function queryAdoption(db: PipelineDb): Promise<AdoptionData> {
  const pkgRecipes = [
    ...NPM_LAB_RECIPES.map((r) => ({ r, registry: 'npm' as const })),
    ...PYPI_LAB_RECIPES.map((r) => ({ r, registry: 'PyPI' as const })),
  ]
  const ids = [
    RAMP_AI_INDEX.id,
    ...pkgRecipes.map((p) => p.r.id),
    ...NPM_CONTROL_RECIPES.map((r) => r.id),
    ...GITHUB_AGENT_RECIPES.map((r) => r.id),
  ]
  const rows = await rowsOf(db, ids)
  const of = (id: string) => rows.filter((r) => r.recipe_id === id)
  const days = new Map(
    [...pkgRecipes.map((p) => p.r), ...NPM_CONTROL_RECIPES].map((r) => [r.id, dayRows(of(r.id))]),
  )
  const derived = deriveDownloadSeries(days)
  const hasSeries = new Set(DOWNLOAD_SERIES.map((s) => s.id))

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
    const clean = days.get(r.id)!.filter((d) => !d.outage)
    const points = clean.map((x) => ({ date: x.date, value: x.value }))
    const windows = windowSums(points)
    const normalized =
      registry === 'npm' ? derivedWindows(clean, derived.index, windows.through, 'downloads') : null
    const shareDays = derived.share.get(r.id)
    const shareOf = shareDays?.length
      ? (() => {
          const on = new Set(shareDays.map((p) => p.date))
          const lab = clean.filter((d) => on.has(d.date))
          return derivedWindows(lab, derived.share_totals[registry], windows.through, 'share')
        })()
      : null
    return [
      {
        recipe_id: r.id,
        lab: r.company,
        registry,
        package: pkg,
        kind: AGENT_PACKAGES.has(pkg) ? ('agent' as const) : ('sdk' as const),
        ...windows,
        weekly: weeklySums(points).map(({ retrospective: _, ...w }) => w),
        normalized_last_28d: normalized?.last ?? null,
        normalized_prior_28d: normalized?.prior ?? null,
        normalized: normalized?.weekly ?? [],
        share_28d: shareOf?.last ?? null,
        share: shareOf?.weekly ?? [],
        series: {
          normalized: hasSeries.has(normalizedId(r.id)) ? normalizedId(r.id) : null,
          share: hasSeries.has(shareId(r.id)) ? shareId(r.id) : null,
        },
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
        weekly: weeklySums(
          rs.map((x) => ({
            date: x.date,
            value: x.value!,
            retrospective: payloadOf(x).retrospective === true,
          })),
        ),
        source: newest ? cite(r.id, `GitHub search: ${agent}`, newest) : null,
      },
    ]
  })

  const controls: AdoptionData['controls'] = {
    series_id: CONTROL_INDEX_ID,
    base: { ...CONTROL_BASE },
    packages: NPM_CONTROL_RECIPES.map((r) => {
      const rs = of(r.id).filter((x) => x.value !== null)
      const newest = newestRow(rs)
      const pkg = rs[0]?.key ?? r.description.replace(/^Daily npm downloads of (\S+),.*$/, '$1')
      return {
        recipe_id: r.id,
        package: pkg,
        source: newest ? cite(r.id, `npm ${pkg}`, newest) : null,
      }
    }),
    index: weeklyRatio(
      derived.index,
      derived.index.map((p) => ({ date: p.date, value: 1 })),
    ),
    outage_days: derived.outage_days,
  }

  return {
    as_of: asOf(rows),
    ramp,
    downloads,
    controls,
    agent_prs,
    caveats: {
      ramp: RAMP_CAVEAT,
      downloads: DOWNLOADS_CAVEAT,
      normalized: NORMALIZED_CAVEAT,
      share: SHARE_CAVEAT,
      agent_prs: AGENT_PRS_CAVEAT,
    },
  }
}

/**
 * A derived series read the way the raw one is: per week, and the 28 days
 * through `through` against the 28 before, each a ratio of sums over the days
 * both carry (at least 21 of 28). Downloads are scaled to the days in the
 * week or window; a share isn't.
 */
function derivedWindows(
  num: readonly SeriesPoint[],
  den: readonly { date: string; value: number }[],
  through: string | null,
  as: 'downloads' | 'share',
) {
  const [weekScale, windowScale] = as === 'share' ? [1, 1] : [7, 28]
  const trailing = trailingRatio(num, den, 28, 21, windowScale)
  const at = (d: string | null) => (d ? (trailing.find((p) => p.date === d)?.value ?? null) : null)
  const prior = through
    ? new Date(Date.parse(`${through}T00:00:00Z`) - 28 * DAY_MS).toISOString().slice(0, 10)
    : null
  return { weekly: weeklyRatio(num, den, weekScale), last: at(through), prior: at(prior) }
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

/** Every recipe the views read, for the cache key. */
export const VIEW_RECIPES = {
  adoption: [
    RAMP_AI_INDEX,
    ...NPM_LAB_RECIPES,
    ...PYPI_LAB_RECIPES,
    ...NPM_CONTROL_RECIPES,
    ...GITHUB_AGENT_RECIPES,
  ].map((r) => r.id),
  limits: LIMIT_RECIPE_IDS,
  pay: PAY_RECIPE_IDS,
  parents: INVESTEE_RECIPES.map((r) => r.id),
} as const
