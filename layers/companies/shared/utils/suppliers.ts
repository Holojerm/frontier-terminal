// Companies whose own filings tie them to a lab or a cloud (GET /api/suppliers,
// /dependencies, /hardware, get_suppliers). Each row is one passage of one SEC
// document, read by hand (layers/companies/server/curated/suppliers.json) or by the judge.

import { z } from 'zod'

import { count } from '../../../core/shared/utils/terminal-format'
import { SUPPLIER_LAYERS, type SupplierLayer } from '../../../core/shared/utils/supplier-layers'
import { LAB_SITE } from '../../../core/shared/utils/lab-names'
import type { LabId } from '../../../core/shared/types/common'

/** The layers /hardware lists. Compute rental and hosting read on /dependencies only. */
export const HARDWARE_LAYERS: readonly SupplierLayer[] = [
  'chips',
  'memory',
  'foundry',
  'networking',
  'optics',
  'servers',
  'cooling',
]

export const SUPPLIER_LAYER_LABEL: Record<SupplierLayer, string> = {
  chips: 'Chips',
  memory: 'Memory',
  foundry: 'Foundry',
  networking: 'Networking',
  optics: 'Optics',
  servers: 'Servers',
  cooling: 'Power and cooling',
  neocloud: 'Compute rental',
  hosting: 'Data-center hosting',
}

/**
 * What the filing says the company is to the counterparty. `concentration` is
 * a customer the filing gives a share for and doesn't name.
 */
export const SUPPLIER_RELATIONS = [
  'customer',
  'supplier',
  'investment',
  'investor',
  'guarantee',
  'concentration',
] as const
export type SupplierRelation = (typeof SUPPLIER_RELATIONS)[number]

/** Read as "<company> <label> <counterparty>". */
export const SUPPLIER_RELATION_LABEL: Record<SupplierRelation, string> = {
  customer: 'sells to',
  supplier: 'buys from',
  investment: 'invests in',
  investor: 'issued shares or warrants to',
  guarantee: 'guarantees leases for',
  concentration: 'unnamed customer',
}

export const SUPPLIER_UNITS = [
  'usd',
  'pct_revenue',
  'pct_revenue_combined',
  'pct_receivables',
  'pct_backlog',
  'shares',
  'gw',
] as const
export type SupplierUnit = (typeof SUPPLIER_UNITS)[number]

const figure = z.object({
  value: z.number().positive(),
  unit: z.enum(SUPPLIER_UNITS),
  /** What the number measures and for which period, in the filing's terms. */
  meaning: z.string().min(1),
})

const ticker = z.string().regex(/^[A-Z.]{1,6}$/)

const curatedRow = z.object({
  ticker,
  company: z.string().min(1),
  layer: z.enum(SUPPLIER_LAYERS),
  relation: z.enum(SUPPLIER_RELATIONS),
  /** The name the filing uses. For `concentration`, the filing's own label ("Customer A"). */
  counterparty: z.string().min(1),
  /** The counterparty's ticker where it is listed. Null for a private lab and for `concentration`. */
  counterparty_ticker: ticker.nullable(),
  /** The tracked lab the counterparty is or owns. */
  counterparty_lab: z.custom<LabId>((v) => typeof v === 'string' && v in LAB_SITE).nullable(),
  /** Each stated in the quote. Empty where the filing names the counterparty and gives no number. */
  figures: z.array(figure).max(3),
  /** The document type: 10-K, 10-Q, 8-K, EX-99.1, 20-F, 6-K. */
  form: z.string().min(1),
  filed: z.iso.date(),
  period: z.string().min(1).nullable(),
  source_url: z.url(),
  source_title: z.string().min(1),
  /** The passage the row rests on, as the document has it. */
  quote: z.string().min(20).max(400),
  /**
   * Where the passage calls the counterparty by a term the document defines
   * ("the Parent"), the term and the passage that defines it.
   */
  alias: z.object({ term: z.string().min(1), quote: z.string().min(20).max(400) }).nullable(),
  /** When the document was last fetched and the quote found in it. */
  fetched_at: z.iso.datetime(),
})

/** The rows read by hand, which seed the stored table (layers/companies/server/suppliers/ingest.ts). */
export const curatedSuppliers = z.object({ rows: z.array(curatedRow) })

export type CuratedSuppliers = z.infer<typeof curatedSuppliers>
export type CuratedSupplierRow = z.infer<typeof curatedRow>

/** hand: read by a person. judge: read by the judge from a stored filing and checked word for word. */
export type SupplierBasis = 'hand' | 'judge'

export type SupplierRow = CuratedSupplierRow & { basis: SupplierBasis }
export type SupplierFigure = z.infer<typeof figure>

/** A share a filing puts on one customer, with who it is where the filing says. */
export interface SupplierShare {
  pct: number
  /** The name, or the filing's label for a customer it doesn't name. */
  counterparty: string
  meaning: string
  filed: string
  /** The share is for several customers together. */
  combined: boolean
}

export interface SupplierCompany {
  ticker: string
  company: string
  layer: SupplierLayer
  /** Every counterparty its filings name, in the order read. */
  named: { name: string; ticker: string | null; lab: LabId | null }[]
  /** The tracked labs among them. */
  labs: LabId[]
  /** The largest share of its revenue its newest filing with one puts on a named customer. */
  top_named_share: SupplierShare | null
  /**
   * The same for a customer the filing doesn't name. Where the filing gives
   * only a share for several customers together, that share and its label.
   */
  top_unnamed_share: SupplierShare | null
  rows: number
}

export interface SupplierGap {
  id: string
  title: string
  reason: string
}

export interface SuppliersData {
  /** The oldest check among the rows: every quote was on its page at or after this. */
  as_of: string | null
  rule: string
  /** One per listed company, the largest stated share of revenue first. */
  companies: SupplierCompany[]
  /** Every disclosure, grouped by company in the same order. */
  rows: SupplierRow[]
  gaps: SupplierGap[]
}

/** A figure as a reader writes it: "$22.4B", "20% of revenue", "160M shares", "6 GW". */
export function supplierFigureText(f: SupplierFigure, usd: (v: number) => string): string {
  switch (f.unit) {
    case 'usd':
      return usd(f.value)
    case 'pct_revenue':
      return `${f.value}% of revenue`
    case 'pct_revenue_combined':
      return `${f.value}% of revenue, together`
    case 'pct_receivables':
      return `${f.value}% of receivables`
    case 'pct_backlog':
      return `${f.value}% of backlog`
    case 'shares':
      return `${compactCount(f.value)} shares`
    case 'gw':
      return `${f.value} GW`
  }
}

function compactCount(v: number): string {
  if (v >= 1e9) return `${Math.round(v / 1e7) / 100}B`
  if (v >= 1e6) return `${Math.round(v / 1e4) / 100}M`
  return count(v)
}
