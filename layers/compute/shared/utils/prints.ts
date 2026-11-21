// The hardware layer's monthly prints (GET /api/prints, the /hardware page, the
// get_hardware_prints MCP tool): Taiwan's monthly revenue for the foundry, the
// server builders and the power and networking makers, and Korea's chip
// exports (Korea Customs Service's headline, and UN Comtrade's HS 8542). Each figure is stored as we first saw it, and a later different
// figure for the same month is a new row, never an overwrite
// (layers/compute/server/prints/).

import { z } from 'zod'

import type { SupplierLayer } from '../../../core/shared/utils/supplier-layers'
import { LAB_SITE } from '../../../core/shared/utils/lab-names'
import type { LabId } from '../../../core/shared/types/common'

export const PRINT_SERIES = ['tw_revenue', 'kr_chip_exports', 'kr_hs8542_exports'] as const
export type PrintSeries = (typeof PRINT_SERIES)[number]

/** month: a calendar month. d10, d20: the first 10 or 20 days of it, a preliminary count. */
export const PRINT_WINDOWS = ['month', 'd10', 'd20'] as const
export type PrintWindow = (typeof PRINT_WINDOWS)[number]

/**
 * Which figure of the release carried the number. A release states the month
 * it is for (print) and restates the month before and the same month a year
 * earlier; a restated figure that differs from the one we hold is a revision.
 */
export const PRINT_OBSERVED_AS = ['print', 'prior_month', 'year_ago'] as const
export type PrintObservedAs = (typeof PRINT_OBSERVED_AS)[number]

/**
 * live: first_seen_at is when our scheduled read first found the figure.
 * backfill: read later from an archive of releases, so first_seen_at is our
 * read and published_at (where the source states one) is the release time.
 */
export type PrintBasis = 'live' | 'backfill'

/**
 * Print sources whose rows are kept for the signals harness and internal
 * research only: no route, page, export or MCP tool reads them. Korea Customs
 * Service's releases before it marked them KOGL Type 1 (about October 2026)
 * carry no licence, and KCS asks to be consulted before an unmarked work is
 * reused (sources.yaml › print_sources, rights not-cleared).
 */
export const PRINT_HELD_SOURCES: readonly string[] = ['kcs-chip-exports-unmarked']

/** The tickers a series is meant to lead, as the signal registry names them. */
export const PRINT_BASKET = ['NVDA', 'SMCI', 'DELL', 'HPE', 'AMD', 'MU', 'TSM'] as const
export type BasketTicker = (typeof PRINT_BASKET)[number]

export interface PrintEntity {
  id: string
  name: string
  series: PrintSeries
  /** The local listing ("2330.TW"), or null for a country aggregate. */
  ticker: string | null
  /** A US listing of the same company, where there is one. */
  us_ticker: string | null
  /** The TWSE company code the revenue release keys on. */
  code: string | null
  layer: SupplierLayer
  /** The basket tickers the series should lead, and why, in a few words. */
  leads: BasketTicker[]
}

/** The Taiwan filers read, in the order the page lists them. */
export const PRINT_ENTITIES: readonly PrintEntity[] = [
  tw('tsmc', 'TSMC', '2330', 'TSM', 'foundry', ['NVDA', 'AMD', 'TSM']),
  tw('hon-hai', 'Hon Hai (Foxconn)', '2317', null, 'servers', ['NVDA', 'SMCI', 'DELL', 'HPE']),
  tw('quanta', 'Quanta Computer', '2382', null, 'servers', ['NVDA', 'SMCI', 'DELL', 'HPE']),
  tw('wistron', 'Wistron', '3231', null, 'servers', ['NVDA', 'SMCI', 'DELL']),
  tw('wiwynn', 'Wiwynn', '6669', null, 'servers', ['NVDA', 'SMCI', 'DELL', 'HPE']),
  tw('gigabyte', 'Gigabyte', '2376', null, 'servers', ['NVDA', 'SMCI']),
  tw('accton', 'Accton', '2345', null, 'networking', ['NVDA']),
  tw('delta', 'Delta Electronics', '2308', null, 'cooling', ['NVDA']),
  {
    id: 'kr-semiconductors',
    name: 'Korea semiconductor exports',
    series: 'kr_chip_exports',
    ticker: null,
    us_ticker: null,
    code: null,
    layer: 'memory',
    leads: ['MU', 'NVDA'],
  },
]

function tw(
  id: string,
  name: string,
  code: string,
  us_ticker: string | null,
  layer: SupplierLayer,
  leads: BasketTicker[],
): PrintEntity {
  return { id, name, series: 'tw_revenue', ticker: `${code}.TW`, us_ticker, code, layer, leads }
}

/**
 * A second series an entity carries from another source, kept apart from its
 * own: UN Comtrade's HS 8542 (integrated circuits) is narrower than KCS's
 * semiconductor headline, so the two never splice into one line.
 */
export const PRINT_EXTRA_SERIES: readonly { entity: string; series: PrintSeries }[] = [
  { entity: 'kr-semiconductors', series: 'kr_hs8542_exports' },
]

export const PRINT_ENTITY = new Map(PRINT_ENTITIES.map((e) => [e.id, e]))
export const PRINT_ENTITY_BY_CODE = new Map(
  PRINT_ENTITIES.filter((e) => e.code).map((e) => [e.code!, e]),
)

/** One stored figure: the table's row as the route serves it. */
export interface PrintRow {
  series: PrintSeries
  entity: string
  period: string
  window: PrintWindow
  value: number
  currency: 'TWD' | 'USD'
  yoy_pct: number | null
  observed_as: PrintObservedAs
  vintage: number
  first_seen_at: string
  published_at: string | null
  due_on: string | null
  basis: PrintBasis
  source_id: string
  source_url: string
  fetched_at: string
}

/** A month's newest figure per entity, with what it was first printed at. */
export interface PrintPoint {
  period: string
  window: PrintWindow
  value: number
  /** The first figure we hold for the month, where a later one differs. */
  first_value: number | null
  yoy_pct: number | null
  first_seen_at: string
  published_at: string | null
  source_url: string
}

export interface PrintTie {
  entity: string
  /** The company the quote is about: the entity, or a member of a country series. */
  company: string
  ticker: string
  /** A subsidiary the source names in the company's place (Quanta's QCT), or null. */
  via: string | null
  counterparty: string
  counterparty_lab: LabId | null
  /** From the company's side: it builds for, or supplies, the counterparty. */
  relation: 'customer' | 'partner'
  source_url: string
  source_title: string
  /** filing, annual_report or company_statement: whose words the quote is. */
  source_kind: 'filing' | 'annual_report' | 'company_statement'
  published: string
  quote: string
  fetched_at: string
}

export interface PrintSeriesData {
  entity: PrintEntity
  /** entity.series, or one of its PRINT_EXTRA_SERIES. */
  series: PrintSeries
  /** Newest month first. */
  points: PrintPoint[]
  /** How many stored rows are revisions of a month already held. */
  revisions: number
  ties: PrintTie[]
}

export interface PrintGap {
  id: string
  title: string
  reason: string
}

export interface PrintsData {
  as_of: string | null
  computed_at: string
  rule: string
  series: PrintSeriesData[]
  gaps: PrintGap[]
}

const tieRow = z.object({
  entity: z.string().refine((v) => PRINT_ENTITY.has(v), 'unknown print entity'),
  company: z.string().min(1),
  ticker: z.string().regex(/^[A-Z0-9.]{1,10}$/),
  via: z.string().min(1).nullable(),
  counterparty: z.string().min(1),
  counterparty_lab: z.custom<LabId>((v) => typeof v === 'string' && v in LAB_SITE).nullable(),
  relation: z.enum(['customer', 'partner']),
  source_url: z.url(),
  source_title: z.string().min(1),
  source_kind: z.enum(['filing', 'annual_report', 'company_statement']),
  published: z.iso.date(),
  quote: z.string().min(20).max(400),
  fetched_at: z.iso.datetime(),
})

/** The hand-read ties (layers/compute/server/curated/print-ties.json). */
export const curatedPrintTies = z.object({ ties: z.array(tieRow) })
