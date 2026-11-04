import { describe, expect, it } from 'vitest'

import limitsAnthropic from '~~/fixtures/recipes/limits-anthropic.md?raw'
import limitsMeta from '~~/fixtures/recipes/limits-meta.md?raw'
import limitsOpenai from '~~/fixtures/recipes/limits-openai-gpt-6-astra.md?raw'
import limitsXai from '~~/fixtures/recipes/limits-xai.md?raw'
import payAnthropic from '~~/fixtures/recipes/pay-anthropic.json?raw'
import payOpenai from '~~/fixtures/recipes/pay-openai.json?raw'
import amzn from '~~/fixtures/recipes/sec-amzn-anthropic.xml?raw'
import msft from '~~/fixtures/recipes/sec-msft-openai.xml?raw'
import {
  INVESTEE_RECIPES,
  extractInvesteeFacts,
  newestInstanceUrl,
} from '../server/theses/recipes/investee-facts'
import { PAY_RECIPES, anthropicBands, bandCells } from '../server/theses/recipes/pay-bands'
import {
  RATE_LIMIT_RECIPES,
  extractAnthropicLimits,
  extractMetaLimits,
  extractOpenAiLimits,
  extractXaiLimits,
  limitValue,
  mdTables,
} from '../server/theses/recipes/rate-limits'
import { fixtureText } from './pipeline/fixtures'

// Parents' filings, published rate limits and posted pay, against fixtures
// fetched 2026-11-04 (docs/source-audit.md). Golden values are the sources' own.

const D = '2026-11-04'
const value = (obs: { key: string; value: number | null }[], key: string) =>
  obs.find((o) => o.key === key)?.value

describe('investee facts in a parent filing', () => {
  it("reads every fact Microsoft tags on OpenAI, as Microsoft's", () => {
    const obs = extractInvesteeFacts(msft, 'msft:OpenAIGlobalLlcMember')
    const q3 = (key: string) => obs.find((o) => o.key === key && o.date === '2026-09-30')?.value
    expect(q3('NonoperatingIncomeExpense|3m')).toBe(272_000_000)
    expect(q3('EquityMethodInvestmentOwnershipPercentage|instant')).toBe(0.24)
    expect(q3('RevenueFromContractWithCustomerExcludingAssessedTax|3m')).toBe(10_000_000_000)
    expect(q3('EquityMethodInvestmentsFunded|instant')).toBe(12_000_000_000)
    // The comparative quarter a year earlier rides along in the same filing.
    expect(
      obs.find((o) => o.key === 'NonoperatingIncomeExpense|3m' && o.date === '2025-09-30')?.value,
    ).toBe(-4_100_000_000)
  })

  it('reads Amazon’s Anthropic facts, keeping a second dimension in the key', () => {
    const obs = extractInvesteeFacts(amzn, 'amzn:AnthropicMember')
    expect(value(obs, 'RevenueRemainingPerformanceObligationAmountPeriodIncreaseDecrease|3m')).toBe(
      100_000_000_000,
    )
    expect(
      value(
        obs,
        'InvestmentOwnedBalanceShares|StatementClassOfStockAxis=PreferredStockMember|instant',
      ),
    ).toBe(164_000_000)
    const ytd = obs.find(
      (o) =>
        o.key ===
          'EquitySecuritiesWithoutReadilyDeterminableFairValueUpwardPriceAdjustmentAnnualAmount|9m' &&
        o.date === '2026-09-30',
    )
    expect(ytd?.value).toBe(62_800_000_000)
    // A duration fact that is not a number is kept as text.
    expect(obs.find((o) => o.value === null)?.payload.text).toMatch(/^P\d+[YM]$/)
  })

  it('follows the submissions feed to the newest 10-Q or 10-K instance', () => {
    // The pipeline's own submissions fixture: its newest 10-Q/10-K is the FY2026 10-K.
    const feed = fixtureText('fixtures/sec/edgar-submissions-msft.json')
    expect(newestInstanceUrl(feed, 789019)).toBe(
      'https://www.sec.gov/Archives/edgar/data/789019/000119312526323660/msft-20260630_htm.xml',
    )
    expect(INVESTEE_RECIPES.map((r) => r.url({ now: new Date(), newest: null }))).toEqual([
      'https://data.sec.gov/submissions/CIK0000789019.json',
      'https://data.sec.gov/submissions/CIK0001018724.json',
    ])
    expect(() => extractInvesteeFacts(msft, 'msft:NoSuchMember')).toThrow(/no facts/)
  })
})

describe('published rate limits', () => {
  it('reads OpenAI tiers by name', () => {
    const obs = extractOpenAiLimits(limitsOpenai, 'gpt-6-astra', D)
    expect(value(obs, 'gpt-6-astra|Build|RPM')).toBe(5_000)
    expect(value(obs, 'gpt-6-astra|Grow|TPM')).toBe(40_000_000)
    expect(value(obs, 'gpt-6-astra|Grow|Batch queue limit')).toBe(15_000_000_000)
  })

  it('reads Anthropic per tier tab, with batch limits and spend caps', () => {
    const obs = extractAnthropicLimits(limitsAnthropic, D)
    expect(value(obs, 'Claude Opus 5.5|Start|RPM')).toBe(4_000)
    expect(value(obs, 'Claude Opus 5.5|Scale|ITPM')).toBe(10_000_000)
    expect(value(obs, 'Claude Opus 4.x|Start|OTPM')).toBe(400_000)
    expect(value(obs, 'spend cap|Scale|USD per month')).toBe(200_000)
    expect(value(obs, 'Message Batches API|Start|RPM')).toBe(1_000)
  })

  it('unpacks xAI tiers from one cell and skips dashes', () => {
    const obs = extractXaiLimits(limitsXai, D)
    expect(value(obs, 'grok-4.7|T4|RPS')).toBe(500)
    expect(value(obs, 'grok-4.7|T0|TPM')).toBe(50_000_000)
    expect(value(obs, 'grok-4.20-multi-agent-0309|T0|TPM')).toBe(2_500_000)
    expect(value(obs, 'spend threshold|Tier 4|USD')).toBe(5_000)
    expect(obs.some((o) => o.key.startsWith('grok-imagine-image|') && o.key.endsWith('|TPM'))).toBe(
      false,
    )
  })

  it('reads Meta without tiers, keeping other limits as text', () => {
    const obs = extractMetaLimits(limitsMeta, D)
    expect(value(obs, 'muse-spark-1.3|all|RPM')).toBe(3_000)
    expect(value(obs, 'sam-3.1|all|TPM')).toBeNull()
    expect(obs.find((o) => o.key === 'muse-voice-transcribe-1.0|all|other')?.payload.text).toBe(
      '256 concurrent streams; 16,000 streams per hour',
    )
  })

  it('stores a new snapshot only when a limit changes, not on any page edit', () => {
    const recipe = RATE_LIMIT_RECIPES.find((r) => r.id === 'limits-meta')!
    const prose = limitsMeta.replace('Rate limits apply', 'Rate limits now apply')
    expect(recipe.fingerprint!(prose)).toBe(recipe.fingerprint!(limitsMeta))
    const raised = limitsMeta.replace(
      '| 3,000                     | 4,000,000',
      '| 6,000                     | 4,000,000',
    )
    expect(raised).not.toBe(limitsMeta)
    expect(recipe.fingerprint!(raised)).not.toBe(recipe.fingerprint!(limitsMeta))
  })

  it('parses limit cells and table context', () => {
    expect(limitValue('2.5M')).toBe(2_500_000)
    expect(limitValue('—')).toBeNull()
    expect(() => limitValue('ask sales')).toThrow(/not a limit/)
    const [t] = mdTables(
      '## Rate limits\n<Tab title="Start tier">\n| A | B |\n| - | - |\n| x | 1 |\n</Tab>\n',
    )
    expect(t).toMatchObject({ section: 'Rate limits', tab: 'Start tier', rows: [['x', '1']] })
  })
})

describe('posted pay bands', () => {
  it('reduces each board to median band midpoints per role family', () => {
    const [openai, anthropic] = PAY_RECIPES.map((r, i) =>
      r.extract([payOpenai, payAnthropic][i]!, { date: D }),
    )
    expect(value(openai!, 'all')).toBe(307_500)
    expect(value(openai!, 'research')).toBe(370_500)
    expect(value(openai!, 'swe')).toBe(355_500)
    expect(value(anthropic!, 'all')).toBe(350_000)
    expect(value(anthropic!, 'research')).toBe(505_000)
    expect(anthropic!.find((o) => o.key === 'research')!.payload).toMatchObject({
      n: 59,
      roles_on_board: 681,
      departments: ['AI Research & Engineering'],
    })
  })

  it('drops placeholder and non-USD bands', () => {
    const { bands } = anthropicBands(payAnthropic)
    expect(bands.every((b) => b.max >= 1_000)).toBe(true)
    expect(bands).toHaveLength(535)
  })

  it('refuses a board fetched without its pay fields', () => {
    expect(() => PAY_RECIPES[0]!.extract('{"jobs":[{"title":"x"}]}', { date: D })).toThrow(
      /compensation/,
    )
    expect(() => bandCells([], 0, { research: ['R'] }, D)).toThrow(/no bands/)
  })
})
