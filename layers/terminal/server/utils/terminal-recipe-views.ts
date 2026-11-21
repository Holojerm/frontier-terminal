// The read side of the recipes audited on 2026-11-04: each query turns
// recipe_observations into one panel's payload (layers/terminal/shared/utils/recipe-views.ts;
// Epoch AI's data centers are the compute layer's, terminal-datacenters.ts,
// the rate limits the pricing layer's, terminal-limits.ts, posted pay the
// talent layer's, terminal-pay.ts, and adoption the adoption layer's,
// terminal-adoption.ts).
// Every figure keeps the URL it was read from and when; a recipe with no
// stored rows yet yields an empty entry, never a guess.

import { inArray } from 'drizzle-orm'

import type { CompanyId } from '#layers/core/shared/utils/companies'
import { humanizeConcept, type ParentFact, type ParentsData } from '../../shared/utils/recipe-views'
import type { RecipeCitation } from '#layers/core/shared/utils/terminal-types/common'
import type { LabId } from '../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import type { PipelineDb } from '#layers/core/server/pipeline/store'
import { PROVIDER_ORDER } from '#layers/core/server/utils/terminal-sources'
import { INVESTEE_RECIPES } from '../theses/recipes/investee-facts'
import { ADOPTION_RECIPE_IDS } from '#layers/adoption/server/utils/terminal-adoption'
import { LIMIT_RECIPE_IDS } from '#layers/pricing/server/utils/terminal-limits'
import { PAY_RECIPE_IDS } from '#layers/talent/server/utils/terminal-pay'

type Row = typeof tables.recipeObservations.$inferSelect

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
  adoption: ADOPTION_RECIPE_IDS,
  limits: LIMIT_RECIPE_IDS,
  pay: PAY_RECIPE_IDS,
  parents: INVESTEE_RECIPES.map((r) => r.id),
} as const
