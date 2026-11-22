// The signal registry: one entry per series the harness scores against the tickers it is
// expected to lead. A new dataset adds one entry here, with a `source` the loaders in
// ./sources.ts already read, or a new source kind there. Every ticker must be one market.ts
// pulls (MARKET_SYMBOLS), and every series attaches to a lab, a listed company or a site
// (layers/signals/test/signals-registry.test.ts).
//
// Sources other layers own are registered by id only: the npm and PyPI recipes and their
// derived series (layers/adoption/server/recipes/download-series.ts) and the probe rollups
// (pipeline/probes/, probe_days).

import { NPM_FIRST_DAY } from '../../../adoption/server/recipes/npm-downloads'
import { PYPI_FIRST_DAY } from '../../../adoption/server/recipes/pypi-downloads'
import { FOREIGN_FILERS } from '../../../companies/server/calls/actuals'
import { curatedCalls } from '../../../companies/server/calls/curated'

export type SignalSource =
  /** recipe_observations rows of one recipe and key. */
  | { kind: 'recipe'; recipe: string; key?: string }
  /** A derived download series by its DOWNLOAD_SERIES id (layers/adoption/server/recipes/download-series.ts): normalized by the control basket, or a lab's SDK share. */
  | { kind: 'download_series'; id: string }
  /** probe_days at the pinned placement: the strained share, (rate_limited + failed) / probes. */
  | { kind: 'probe_days'; lab: LabId }
  /** OpenRouter's weekly token share for one lab (terminal-rankings.ts › rankingWeeks). */
  | { kind: 'openrouter_share'; lab: LabId }
  /** The daily GPU history behind /api/gpu-prices: the cross-provider median list price, or the spot share's midpoint. */
  | { kind: 'gpu'; gpu: 'H100' | 'B200'; metric: 'median' | 'spot_share' }
  /** Open roles on the lab's job board, from the history behind /api/hiring/history. */
  | { kind: 'hiring'; lab: LabId }
  /** A new model on the lab's price list: model-floor alerts. */
  | { kind: 'launches'; lab: LabId }
  /** A listed model's input price moving on the lab's price list (changes on `model`). */
  | { kind: 'price_changes'; lab: LabId; direction: 'cut' | 'raise' }
  /** Each filed revenue period the press had reported first, signed by whether the filing beat the reports. */
  | { kind: 'revenue_vs_reported'; lab: LabId }
  /** EIA-930 demand on one balancing authority (grid_load_days): each whole month's or week's average load against a year before. */
  | { kind: 'grid_load'; ba: string; period: 'month' | 'week' }
  /** ERCOT's large-load figures (ercot_large_load_facts), each month as the first report that states it put it. */
  | { kind: 'ercot_large_loads'; metric: 'observed_peak_mw' | 'approved_to_energize_mw' }
  /**
   * A print series (hardware_prints) in one window: the year-on-year change its
   * first release stated, or with `yoy: 'derived'` (a source that states none)
   * the change we compute from the values as they stood when the month was public.
   */
  | { kind: 'prints'; series: PrintSeries; entity: string; window?: PrintWindow; yoy?: 'derived' }
  /** Each filing that settles a company's call guidance (guidance_resolutions), signed: the error against the guided midpoint, positive for a beat. */
  | { kind: 'guidance_surprise'; ticker: string; metric?: 'capex' }
  /** A listed company's job board (listed_hiring_reads): every open role, or its data-center roles. */
  | { kind: 'listed_hiring'; board: string; metric: 'total' | 'datacenter' }
  /**
   * A filer's quarterly figure on a lab as first filed: the 3-month facts on
   * `member` (filed_facts), and before it tagged them the same figure read
   * from its words (filed_text_facts › text_metric). Public on its filing date.
   */
  | {
      kind: 'filed_quarters'
      ticker: string
      concept: string
      member: string
      text_metric?: string
    }
  /**
   * A recipe's quarterly figure as the log change on the quarter before.
   * Public on payload.released where the row has it, else lag_days after the
   * quarter's end.
   */
  | { kind: 'quarterly_growth'; recipe: string; key: string; lag_days: number }
  /** A published rate limit or spend cap raised: archived copies of the page (archived_rate_limits), then the live limits recipe. */
  | { kind: 'limit_raises'; recipe: string }

export interface SignalDef {
  /** Stable: results, exports and links key on it. Never reuse a retired id. */
  id: string
  label: string
  entity: { kind: SignalEntityKind; id: string }
  /** The tickers the series is expected to lead. Each one is a test, so keep the list short. */
  tickers: readonly string[]
  source: SignalSource
  transform: SignalTransform
  frequency: SignalFrequency
  /**
   * lead_lag correlates each period's change with forward returns. event
   * averages the abnormal return around each event; `signed` multiplies it by
   * the sign of the event's value first.
   */
  test: SignalTest
  signed?: boolean
  /** How a daily source folds into the series' period: summed (flows), averaged, or its last value (levels). */
  aggregate?: 'sum' | 'mean' | 'last'
  /**
   * Days after a period ends before its value is public. A return is measured
   * from the first session after that, so the test never reads a number
   * before anyone could have.
   */
  available_after_days: number
  /** When the source's history starts. */
  history_from: string
}

/** The listed companies each lab's series are tested against: its own listing, then its closest ties in /api/listed. */
export const LAB_TICKERS: Readonly<Partial<Record<LabId, readonly string[]>>> = {
  anthropic: ['ANT', 'AMZN', 'GOOGL', 'AVGO'],
  openai: ['MSFT', 'ORCL', 'NVDA', 'CRWV'],
  google: ['GOOGL', 'AVGO', 'MRVL'],
  meta: ['META', 'AMD', 'NBIS'],
  xai: ['NVDA', 'DELL', 'SMCI'],
  mistral: ['NVDA'],
  deepseek: ['NVDA', 'AVGO'],
}

const lab = (id: LabId) => ({ kind: 'lab' as const, id })
const tickersOf = (id: LabId): readonly string[] => LAB_TICKERS[id] ?? []

/** A share needs every core SDK: the newest of the four on npm is @google/genai. */
const NPM_SHARE_FROM = NPM_FIRST_DAY['npm-google-genai']

/** npm downloads divided by the non-AI control basket, so a registry-wide swing cancels out. */
const npm = (recipe: keyof typeof NPM_FIRST_DAY, labId: LabId, label: string): SignalDef => ({
  id: recipe,
  label,
  entity: lab(labId),
  tickers: tickersOf(labId),
  source: { kind: 'download_series', id: `${recipe}-normalized` },
  transform: 'normalized',
  frequency: 'weekly',
  test: 'lead_lag',
  aggregate: 'sum',
  available_after_days: 1,
  history_from: NPM_FIRST_DAY[recipe],
})

/** A lab's core SDK as a share of the tracked labs' core SDKs on one registry. */
const sdkShare = (recipe: string, labId: LabId, label: string, from: string): SignalDef => ({
  id: `${recipe}-share`,
  label,
  entity: lab(labId),
  tickers: tickersOf(labId),
  source: { kind: 'download_series', id: `${recipe}-share` },
  transform: 'share',
  frequency: 'weekly',
  test: 'lead_lag',
  aggregate: 'mean',
  available_after_days: 1,
  history_from: from,
})

/** As on npm: the newest of the five core SDKs on PyPI is google-genai. */
const PYPI_SHARE_FROM = PYPI_FIRST_DAY['pypi-google-genai']

const pypi = (recipe: keyof typeof PYPI_FIRST_DAY, labId: LabId, label: string): SignalDef => ({
  id: recipe,
  label,
  entity: lab(labId),
  tickers: tickersOf(labId),
  source: { kind: 'recipe', recipe },
  transform: 'level',
  frequency: 'weekly',
  test: 'lead_lag',
  aggregate: 'sum',
  available_after_days: 1,
  history_from: PYPI_FIRST_DAY[recipe],
})

const ramp = (key: string, labId: LabId, label: string): SignalDef => ({
  id: `ramp-ai-index-${key}`,
  label,
  entity: lab(labId),
  tickers: tickersOf(labId),
  source: { kind: 'recipe', recipe: 'ramp-ai-index', key },
  transform: 'share',
  frequency: 'monthly',
  test: 'lead_lag',
  // Ramp publishes a month's index in the middle of the next month.
  available_after_days: 20,
  history_from: '2023-07-01',
})

const openrouter = (labId: LabId, label: string): SignalDef => ({
  id: `openrouter-share-${labId}`,
  label,
  entity: lab(labId),
  tickers: tickersOf(labId),
  source: { kind: 'openrouter_share', lab: labId },
  transform: 'share',
  frequency: 'weekly',
  test: 'lead_lag',
  available_after_days: 1,
  history_from: '2025-08-01',
})

const probes = (labId: LabId, label: string): SignalDef => ({
  id: `probes-strain-${labId}`,
  label,
  entity: lab(labId),
  tickers: tickersOf(labId),
  source: { kind: 'probe_days', lab: labId },
  transform: 'share',
  frequency: 'weekly',
  test: 'lead_lag',
  aggregate: 'last',
  available_after_days: 1,
  history_from: '2026-11-21',
})

const hiring = (labId: LabId, label: string): SignalDef => ({
  id: `hiring-open-roles-${labId}`,
  label,
  entity: lab(labId),
  tickers: tickersOf(labId),
  source: { kind: 'hiring', lab: labId },
  transform: 'level',
  frequency: 'weekly',
  test: 'lead_lag',
  aggregate: 'last',
  available_after_days: 1,
  history_from: '2026-08-25',
})

/**
 * Launches and price cuts run from the archived price lists (each lab's
 * first archive era, pipeline/archive/eras.ts) to 2026-08-25, then from the
 * live record. An archived event is dated by the lab's release note where one
 * names it, else at the copy before it, keeping the gap between the copies;
 * the harness scores a gap wider than two days only at the 20- and 60-session
 * horizons (harness.ts › maxWindowDays).
 */
const launches = (labId: LabId, label: string, from: string): SignalDef => ({
  id: `launches-${labId}`,
  label,
  entity: lab(labId),
  tickers: tickersOf(labId),
  source: { kind: 'launches', lab: labId },
  transform: 'level',
  frequency: 'event',
  test: 'event',
  available_after_days: 0,
  history_from: from,
})

const priceCuts = (labId: LabId, label: string, from: string): SignalDef => ({
  id: `price-cuts-${labId}`,
  label,
  entity: lab(labId),
  tickers: tickersOf(labId),
  source: { kind: 'price_changes', lab: labId, direction: 'cut' },
  transform: 'level',
  frequency: 'event',
  test: 'event',
  available_after_days: 0,
  history_from: from,
})

/**
 * What a hyperscaler files about a lab, quarter by quarter, as first filed.
 * Microsoft has tagged its OpenAI line since its 10-Q for the quarter to
 * 2024-09-30; Amazon tagged Anthropic from 2026, and its words carry the
 * quarters before. Thin for years: a quarter is one point.
 */
const filedQuarters = (
  id: string,
  label: string,
  labId: LabId,
  ticker: string,
  source: Extract<SignalSource, { kind: 'filed_quarters' }>,
  from: string,
): SignalDef => ({
  id,
  label,
  entity: lab(labId),
  tickers: [ticker],
  source,
  transform: 'change',
  frequency: 'monthly',
  test: 'lead_lag',
  aggregate: 'last',
  available_after_days: 0,
  history_from: from,
})

const gpu = (
  id: string,
  label: string,
  g: 'H100' | 'B200',
  metric: 'median' | 'spot_share',
): SignalDef => ({
  id,
  label,
  entity: { kind: 'listed', id: 'NVDA' },
  tickers: ['NVDA', 'CRWV', 'NBIS', 'ORCL'],
  source: { kind: 'gpu', gpu: g, metric },
  transform: metric === 'median' ? 'level' : 'share',
  frequency: 'weekly',
  test: 'lead_lag',
  aggregate: 'last',
  available_after_days: 1,
  history_from: '2026-11-07',
})

/**
 * The listed companies tied to the lab sites in each balancing authority
 * (power_site_ties, placed by /api/grid-load): utilities, generators, equipment
 * makers and hosts. WMB and BE aren't here: Meta Prometheus's plant is behind
 * the meter, and no page names a grid for Stargate New Mexico.
 */
const GRID_TICKERS: Readonly<Record<string, readonly string[]>> = {
  ERCO: ['GEV', 'CIFR'],
  PJM: ['AEP'],
  MISO: ['DTE', 'WEC', 'ETR'],
  NYIS: ['WULF'],
  AZPS: ['PNW'],
}

/**
 * A grid's average load against the same month (or the week 52 weeks) before:
 * the change itself, so seasons cancel. EIA posts each day's hours within a
 * day or two.
 */
const gridLoad = (ba: string, short: string, period: 'month' | 'week'): SignalDef => ({
  id: `grid-load-${ba.toLowerCase()}-${period === 'month' ? 'monthly' : 'weekly'}-yoy`,
  label: `${short} grid load against a year before, ${period === 'month' ? 'monthly' : 'weekly'}`,
  entity: { kind: 'grid', id: ba },
  tickers: GRID_TICKERS[ba] ?? [],
  source: { kind: 'grid_load', ba, period },
  transform: 'change',
  frequency: period === 'month' ? 'monthly' : 'weekly',
  test: 'lead_lag',
  aggregate: 'last',
  available_after_days: 2,
  // The first whole month with a year before it (the files start in 2018).
  history_from: '2019-01-01',
})

/**
 * ERCOT's large-load figures as first stated. ERCOT posts its Monthly
 * Operational Overview with each Board meeting, 15 to 22 days after the month.
 */
const ercot = (
  metric: 'observed_peak_mw' | 'approved_to_energize_mw',
  label: string,
): SignalDef => ({
  id: metric === 'observed_peak_mw' ? 'ercot-large-load-observed' : 'ercot-large-load-approved',
  label,
  entity: { kind: 'grid', id: 'ERCO' },
  tickers: GRID_TICKERS.ERCO!,
  source: { kind: 'ercot_large_loads', metric },
  transform: 'level',
  frequency: 'monthly',
  test: 'lead_lag',
  aggregate: 'last',
  available_after_days: 23,
  history_from: '2025-04-01',
})

/**
 * Korea's HS 8542 exports from UN Comtrade, with the year-on-year change we
 * compute from the values. Each month is dated public at the lastReleased of
 * its dataset, since the figure we hold is the one Comtrade serves now. Korea
 * is released in yearly batches, and 2014 to 2022 were re-released in 2024 and
 * 2025, so most of the history shares a few public days; the harness shrinks
 * such a sample to its independent returns and reports it thin until monthly
 * releases build up. available_after_days is the fallback for a month with no
 * release time: the shortest lag getDA shows from a month’s end to its
 * lastReleased (90 days, December 2013).
 */
const krHs8542: SignalDef = {
  id: 'kr-hs8542-exports',
  label: 'Korea HS 8542 exports (UN Comtrade), month, year on year',
  entity: { kind: 'supplier', id: 'kr-semiconductors' },
  tickers: ['MU', 'NVDA'],
  source: {
    kind: 'prints',
    series: 'kr_hs8542_exports',
    entity: 'kr-semiconductors',
    window: 'month',
    yoy: 'derived',
  },
  transform: 'change',
  frequency: 'monthly',
  test: 'lead_lag',
  aggregate: 'last',
  available_after_days: 90,
  // The first change needs January 2013 as its base.
  history_from: '2014-01-01',
}

/**
 * A Taiwan company's monthly revenue as first released, read as the
 * year-on-year change the release states. Revenue is due by the 10th of the
 * next month (Securities and Exchange Act art. 36), and TSMC files its 6-K the
 * same day, so a month is public 10 days after it ends.
 */
const twRevenue = (entity: (typeof PRINT_ENTITIES)[number]): SignalDef => ({
  id: `tw-revenue-${entity.id}`,
  label: `${entity.name} monthly revenue, year on year`,
  // TSMC has a US listing we price; the rest are listed only in Taipei.
  entity: entity.us_ticker
    ? { kind: 'listed', id: entity.us_ticker }
    : { kind: 'supplier', id: entity.id },
  tickers: entity.leads,
  source: { kind: 'prints', series: 'tw_revenue', entity: entity.id },
  transform: 'change',
  frequency: 'monthly',
  test: 'lead_lag',
  aggregate: 'last',
  available_after_days: 10,
  // TSMC's 6-Ks reach back to 2015 and Accton's page to 2023-07; the others start at our first read.
  history_from:
    entity.id === 'tsmc' ? '2015-01-01' : entity.id === 'accton' ? '2023-07-01' : '2026-10-01',
})

/**
 * Korea's chip exports in one window, as the year-on-year change the release
 * states. Korea Customs Service posts the first 10 days on the 11th, the
 * first 20 on the 21st and the confirmed month about the 15th of the next, so
 * the 10- and 20-day counts lead the month. Each point is dated public on its
 * release's embargo day, or the day KCS posted it; available_after_days is
 * the fallback for neither. MU is the listed memory maker; Samsung and SK hynix
 * aren't in MARKET_SYMBOLS.
 */
const krChips = (window: PrintWindow, label: string, lag: number): SignalDef => ({
  id: window === 'month' ? 'kr-chip-exports' : `kr-chip-exports-${window}`,
  label,
  entity: { kind: 'supplier', id: 'kr-semiconductors' },
  tickers: PRINT_ENTITIES.find((e) => e.id === 'kr-semiconductors')!.leads,
  source: { kind: 'prints', series: 'kr_chip_exports', entity: 'kr-semiconductors', window },
  transform: 'change',
  frequency: 'monthly',
  test: 'lead_lag',
  aggregate: 'last',
  available_after_days: lag,
  // The 10- and 20-day releases state the chip figure from August 2021; the
  // confirmed month has it from the board's oldest release, August 2016.
  history_from: window === 'month' ? '2016-08-01' : '2021-08-01',
})

/**
 * A company's guidance surprise: each filing that settles a figure its
 * management guided on a call, the error against the midpoint (averaged when
 * one filing settles several). The 10-Q or 10-K is the event; the call that
 * gave the guidance is earlier. Foreign filers' quarters carry no XBRL, so
 * they have no events. History starts with the first calls read.
 */
const guidanceSurprise = (ticker: string, company: string): SignalDef => ({
  id: `guidance-surprise-${ticker.toLowerCase()}`,
  label: `${company} filed results against its call guidance`,
  entity: { kind: 'listed', id: ticker },
  tickers: [ticker],
  source: { kind: 'guidance_surprise', ticker },
  transform: 'change',
  frequency: 'event',
  test: 'event',
  signed: true,
  available_after_days: 0,
  history_from: '2018-01-01',
})

/** The chip and network makers a hyperscaler's capex is expected to lead. */
const CAPEX_LEADS: readonly string[] = ['NVDA', 'AVGO', 'AMD', 'ANET']

/** A hyperscaler's filed capex against the capex it guided on its calls, tested on the suppliers it buys from. */
const capexSurprise = (ticker: string, company: string): SignalDef => ({
  ...guidanceSurprise(ticker, company),
  id: `guidance-capex-surprise-${ticker.toLowerCase()}`,
  label: `${company} filed capex against its call guidance`,
  tickers: CAPEX_LEADS,
  source: { kind: 'guidance_surprise', ticker, metric: 'capex' },
})

/** The companies whose calls are read, by ticker; the four foreign filers have no scorable quarters. */
const GUIDANCE_SIGNAL_COMPANIES: readonly [string, string][] = curatedCalls.companies
  .filter((c) => !FOREIGN_FILERS.has(c.ticker))
  .map((c) => [c.ticker, c.company])

/**
 * The stocks a host's data-center hiring should lead beyond its own: the GPU
 * maker it buys from, and the tenants and lessees its filings name
 * (suppliers.json). Hiring for a site comes before the megawatts, and the
 * megawatts before the revenue.
 */
const LISTED_HIRING_TICKERS: Readonly<Record<string, readonly string[]>> = {
  CRWV: ['NVDA'],
  NBIS: ['NVDA', 'MSFT'],
  GLXY: ['CRWV'],
  HUT: ['ANT'],
  CIFR: ['AMZN', 'GOOGL'],
  GOOGL: ['AVGO'],
}

/**
 * A listed company's open roles, as each week's last read. History starts
 * at our first read of the boards, so every series is thin for now.
 */
const listedHiring = (
  board: string,
  ticker: string,
  company: string,
  metric: 'total' | 'datacenter',
): SignalDef => ({
  id: `listed-hiring-${ticker.toLowerCase()}-${metric === 'total' ? 'open-roles' : 'datacenter-roles'}`,
  label: metric === 'total' ? `Open roles, ${company}` : `Data-center roles, ${company}`,
  entity: { kind: 'listed', id: ticker },
  tickers: metric === 'total' ? [ticker] : [ticker, ...(LISTED_HIRING_TICKERS[ticker] ?? [])],
  source: { kind: 'listed_hiring', board, metric },
  transform: 'level',
  frequency: 'weekly',
  test: 'lead_lag',
  aggregate: 'last',
  available_after_days: 1,
  history_from: '2026-11-21',
})

/** Every board's total, and a host's data-center roles: a chipmaker's "data center" roles sell to them. */
const LISTED_HIRING_SIGNALS: readonly SignalDef[] = LISTED_BOARDS.flatMap((b) => [
  ...(b.scope === 'all' ? [listedHiring(b.id, b.ticker, b.company, 'total')] : []),
  ...(b.host ? [listedHiring(b.id, b.ticker, b.company, 'datacenter')] : []),
])

export const SIGNALS: readonly SignalDef[] = [
  npm('npm-anthropic-sdk', 'anthropic', '@anthropic-ai/sdk npm downloads'),
  npm('npm-claude-code', 'anthropic', 'Claude Code npm downloads'),
  npm('npm-claude-agent-sdk', 'anthropic', 'Claude Agent SDK npm downloads'),
  npm('npm-openai', 'openai', 'openai npm downloads'),
  npm('npm-codex', 'openai', 'Codex CLI npm downloads'),
  npm('npm-openai-agents', 'openai', 'OpenAI Agents SDK npm downloads'),
  npm('npm-google-genai', 'google', '@google/genai npm downloads'),
  npm('npm-gemini-cli', 'google', 'Gemini CLI npm downloads'),
  npm('npm-mistral', 'mistral', 'Mistral npm downloads'),
  sdkShare(
    'npm-anthropic-sdk',
    'anthropic',
    'Anthropic share of lab SDK npm downloads',
    NPM_SHARE_FROM,
  ),
  sdkShare('npm-openai', 'openai', 'OpenAI share of lab SDK npm downloads', NPM_SHARE_FROM),
  sdkShare('npm-google-genai', 'google', 'Google share of lab SDK npm downloads', NPM_SHARE_FROM),
  sdkShare(
    'pypi-anthropic',
    'anthropic',
    'Anthropic share of lab SDK PyPI downloads',
    PYPI_SHARE_FROM,
  ),
  sdkShare('pypi-openai', 'openai', 'OpenAI share of lab SDK PyPI downloads', PYPI_SHARE_FROM),
  pypi('pypi-anthropic', 'anthropic', 'anthropic PyPI downloads'),
  pypi('pypi-claude-agent-sdk', 'anthropic', 'claude-agent-sdk PyPI downloads'),
  pypi('pypi-openai', 'openai', 'openai PyPI downloads'),
  pypi('pypi-openai-agents', 'openai', 'openai-agents PyPI downloads'),
  pypi('pypi-google-genai', 'google', 'google-genai PyPI downloads'),
  pypi('pypi-mistralai', 'mistral', 'mistralai PyPI downloads'),
  pypi('pypi-xai-sdk', 'xai', 'xai-sdk PyPI downloads'),
  ramp('anthropic', 'anthropic', 'Ramp AI Index, Anthropic adoption'),
  ramp('openai', 'openai', 'Ramp AI Index, OpenAI adoption'),
  ramp('xai', 'xai', 'Ramp AI Index, xAI adoption'),
  openrouter('anthropic', 'OpenRouter token share, Anthropic'),
  openrouter('openai', 'OpenRouter token share, OpenAI'),
  openrouter('google', 'OpenRouter token share, Google'),
  openrouter('xai', 'OpenRouter token share, xAI'),
  openrouter('deepseek', 'OpenRouter token share, DeepSeek'),
  probes('anthropic', 'Probe strain, Anthropic'),
  probes('openai', 'Probe strain, OpenAI'),
  probes('google', 'Probe strain, Google'),
  hiring('anthropic', 'Open roles, Anthropic'),
  hiring('openai', 'Open roles, OpenAI'),
  hiring('google', 'Open roles, Google DeepMind'),
  hiring('xai', 'Open roles, xAI'),
  hiring('meta', 'Open roles, Meta'),
  launches('anthropic', 'Model launches, Anthropic', '2024-03-01'),
  launches('openai', 'Model launches, OpenAI', '2023-01-01'),
  launches('google', 'Model launches, Google', '2023-12-01'),
  launches('xai', 'Model launches, xAI', '2024-11-04'),
  launches('deepseek', 'Model launches, DeepSeek', '2024-05-01'),
  launches('mistral', 'Model launches, Mistral', '2023-12-01'),
  priceCuts('anthropic', 'Price cuts, Anthropic', '2024-03-01'),
  priceCuts('openai', 'Price cuts, OpenAI', '2023-01-01'),
  priceCuts('google', 'Price cuts, Google', '2023-12-01'),
  priceCuts('xai', 'Price cuts, xAI', '2024-11-04'),
  priceCuts('deepseek', 'Price cuts, DeepSeek', '2024-05-01'),
  filedQuarters(
    'msft-openai-other-income',
    'Microsoft’s quarterly gain or loss on OpenAI, as first filed',
    'openai',
    'MSFT',
    {
      kind: 'filed_quarters',
      ticker: 'MSFT',
      concept: 'us-gaap:NonoperatingIncomeExpense',
      member: 'msft:OpenAIGlobalLlcMember',
    },
    '2024-07-01',
  ),
  filedQuarters(
    'amzn-anthropic-upward-marks',
    'Amazon’s quarterly upward marks on Anthropic, as first filed',
    'anthropic',
    'AMZN',
    {
      kind: 'filed_quarters',
      ticker: 'AMZN',
      concept:
        'us-gaap:EquitySecuritiesWithoutReadilyDeterminableFairValueUpwardPriceAdjustmentAnnualAmount',
      member: 'amzn:AnthropicMember',
      text_metric: 'upward_adjustment',
    },
    '2025-07-01',
  ),
  {
    id: 'googl-api-tokens',
    label: 'Alphabet’s stated API tokens per minute, change on the quarter',
    entity: lab('google'),
    tickers: ['GOOGL'],
    source: {
      kind: 'quarterly_growth',
      recipe: 'sec-googl-api-tokens',
      key: 'api_tokens_per_minute',
      // Alphabet's releases have gone out 22 to 36 days after the quarter.
      lag_days: 36,
    },
    transform: 'change',
    frequency: 'monthly',
    test: 'lead_lag',
    aggregate: 'last',
    available_after_days: 0,
    history_from: '2025-07-01',
  },
  {
    id: 'limit-raises-anthropic',
    label: 'Rate limits and spend caps raised, Anthropic',
    entity: lab('anthropic'),
    tickers: tickersOf('anthropic'),
    source: { kind: 'limit_raises', recipe: 'limits-anthropic' },
    transform: 'level',
    frequency: 'event',
    test: 'event',
    available_after_days: 0,
    // The first copy of the page the Archive holds that reads.
    history_from: '2024-03-01',
  },
  gpu('gpu-h100-median', 'H100 median list price', 'H100', 'median'),
  gpu('gpu-b200-median', 'B200 median list price', 'B200', 'median'),
  gpu('gpu-h100-spot-share', 'H100 spot share', 'H100', 'spot_share'),
  {
    id: 'revenue-vs-reported-anthropic',
    label: 'Anthropic filed revenue against press reports',
    entity: lab('anthropic'),
    tickers: tickersOf('anthropic'),
    source: { kind: 'revenue_vs_reported', lab: 'anthropic' },
    transform: 'change',
    frequency: 'event',
    test: 'event',
    signed: true,
    available_after_days: 0,
    history_from: '2026-10-26',
  },
  {
    id: 'revenue-vs-reported-openai',
    label: 'OpenAI filed revenue against press reports',
    entity: lab('openai'),
    tickers: tickersOf('openai'),
    source: { kind: 'revenue_vs_reported', lab: 'openai' },
    transform: 'change',
    frequency: 'event',
    test: 'event',
    signed: true,
    available_after_days: 0,
    history_from: '2026-10-26',
  },
  gridLoad('ERCO', 'ERCOT', 'month'),
  gridLoad('PJM', 'PJM', 'month'),
  gridLoad('MISO', 'MISO', 'month'),
  gridLoad('NYIS', 'NYISO', 'month'),
  gridLoad('AZPS', 'APS (Arizona)', 'month'),
  gridLoad('ERCO', 'ERCOT', 'week'),
  gridLoad('PJM', 'PJM', 'week'),
  gridLoad('MISO', 'MISO', 'week'),
  gridLoad('NYIS', 'NYISO', 'week'),
  gridLoad('AZPS', 'APS (Arizona)', 'week'),
  ercot('observed_peak_mw', 'ERCOT large load observed, sum of monthly peaks'),
  ercot('approved_to_energize_mw', 'ERCOT large load approved to energize'),
  ...PRINT_ENTITIES.filter((e) => e.series === 'tw_revenue').map(twRevenue),
  krChips('d10', 'Korea chip exports, first 10 days, year on year', 0),
  krChips('d20', 'Korea chip exports, first 20 days, year on year', 0),
  krChips('month', 'Korea chip exports, month, year on year', 20),
  krHs8542,
  ...GUIDANCE_SIGNAL_COMPANIES.map(([ticker, company]) => guidanceSurprise(ticker, company)),
  // Amazon guides net capex, which isn't scored (calls/actuals.ts).
  capexSurprise('MSFT', 'Microsoft'),
  capexSurprise('GOOGL', 'Alphabet'),
  capexSurprise('META', 'Meta'),
  capexSurprise('ORCL', 'Oracle'),
  ...LISTED_HIRING_SIGNALS,
]

/** Where a series is read from, in the names /data and the exports use. */
export function sourceLabel(source: SignalSource): string {
  switch (source.kind) {
    case 'recipe':
      return `recipe_observations: ${source.recipe}${source.key ? ` (${source.key})` : ''}`
    case 'download_series':
      return `download_series: ${source.id}`
    case 'probe_days':
      return `probe_days: ${source.lab}`
    case 'openrouter_share':
      return 'rankings: OpenRouter weekly tokens'
    case 'gpu':
      return `gpu-prices history: ${source.gpu} ${source.metric === 'median' ? 'median' : 'spot share'}`
    case 'hiring':
      return `jobs: ${source.lab} open roles`
    case 'launches':
      return 'archived_prices: first listing, to 2026-08-25; then alerts: model-floor'
    case 'price_changes':
      return 'archived_prices: input price between copies, to 2026-08-25; then changes: model input price'
    case 'revenue_vs_reported':
      return 'ground truth: filed revenue against reported'
    case 'grid_load':
      return `grid_load_days: ${source.ba}, ${source.period === 'month' ? 'monthly' : 'weekly'} against a year before`
    case 'ercot_large_loads':
      return `ercot_large_load_facts: ${source.metric}, first stated`
    case 'prints':
      return `hardware_prints: ${source.series} ${source.entity}${source.window && source.window !== 'month' ? ` ${source.window}` : ''}, ${source.yoy === 'derived' ? 'year-on-year change computed from the values as public' : 'stated year-on-year change'}, first release`
    case 'guidance_surprise':
      return `guidance_resolutions: ${source.ticker}${source.metric ? ` ${source.metric}` : ''}, error against the guided midpoint`
    case 'listed_hiring':
      return `listed_hiring_reads: ${source.board}, ${source.metric === 'total' ? 'open roles' : 'data-center roles'}`
    case 'filed_quarters':
      return `filed_facts: ${source.ticker} ${source.concept} on ${source.member}${source.text_metric ? `, before that filed_text_facts: ${source.text_metric}` : ''}, 3 months, first filed`
    case 'limit_raises':
      return `archived_rate_limits, then recipe_observations: ${source.recipe}, each limit raised`
    case 'quarterly_growth':
      return `recipe_observations: ${source.recipe} (${source.key}), log change on the quarter, public on its release`
  }
}
