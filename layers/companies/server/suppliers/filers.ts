// The companies the suppliers table reads, and the counterparties a passage
// may name. The filers are the companies of the hand-read table
// (../curated/suppliers.json), each with the CIK its own documents are filed
// under; the filings lane reads their new documents (ingest.ts).

import type { SupplierLayer } from '#layers/core/shared/utils/supplier-layers'
import type { LabId } from '../../../core/shared/types/common'

export interface SupplierFiler {
  ticker: string
  cik: string
  company: string
  layer: SupplierLayer
  /** The forms read: a domestic filer's 10-Q, 10-K and 8-K, a foreign filer's 20-F and 6-K. */
  forms: readonly string[]
}

const DOMESTIC = ['10-Q', '10-K', '8-K'] as const
const FOREIGN = ['20-F', '6-K'] as const

/** Forms a later document of the same company restates, so a passage missing from it has ended. */
export const PERIODIC_FORMS: readonly string[] = ['10-Q', '10-K', '20-F']

const filer = (
  ticker: string,
  cik: number,
  company: string,
  layer: SupplierLayer,
  forms: readonly string[] = DOMESTIC,
): SupplierFiler => ({ ticker, cik: String(cik).padStart(10, '0'), company, layer, forms })

export const SUPPLIER_FILERS: readonly SupplierFiler[] = [
  filer('AAOI', 1158114, 'Applied Optoelectronics', 'optics'),
  filer('AKAM', 1086222, 'Akamai', 'neocloud'),
  filer('ALAB', 1736297, 'Astera Labs', 'networking'),
  filer('AMD', 2488, 'AMD', 'chips'),
  filer('ANET', 1596532, 'Arista Networks', 'networking'),
  filer('APLD', 1144879, 'Applied Digital', 'hosting'),
  filer('ARM', 1973239, 'Arm', 'chips', FOREIGN),
  filer('AVGO', 1730168, 'Broadcom', 'chips'),
  filer('CBRS', 2021728, 'Cerebras', 'chips'),
  filer('CIEN', 936395, 'Ciena', 'optics'),
  filer('CIFR', 1819989, 'Cipher Mining', 'hosting'),
  filer('CLS', 1030894, 'Celestica', 'servers'),
  filer('COHR', 820318, 'Coherent', 'optics'),
  filer('CORZ', 1839341, 'Core Scientific', 'hosting'),
  filer('CRDO', 1807794, 'Credo', 'networking'),
  filer('CRWV', 1769628, 'CoreWeave', 'neocloud'),
  filer('DELL', 1571996, 'Dell', 'servers'),
  filer('FN', 1408710, 'Fabrinet', 'optics'),
  filer('GLXY', 1859392, 'Galaxy Digital', 'hosting'),
  filer('HPE', 1645590, 'Hewlett Packard Enterprise', 'servers'),
  filer('HUT', 1964789, 'Hut 8', 'hosting'),
  filer('INTC', 50863, 'Intel', 'chips'),
  filer('IREN', 1878848, 'IREN', 'neocloud'),
  filer('LITE', 1633978, 'Lumentum', 'optics'),
  filer('MRVL', 1835632, 'Marvell', 'chips'),
  filer('NBIS', 1513845, 'Nebius', 'neocloud', FOREIGN),
  filer('NVDA', 1045810, 'Nvidia', 'chips'),
  filer('QCOM', 804328, 'Qualcomm', 'chips'),
  filer('RIOT', 1167419, 'Riot Platforms', 'hosting'),
  filer('SMCI', 1375365, 'Super Micro', 'servers'),
  filer('TSM', 1046179, 'TSMC', 'foundry', FOREIGN),
  filer('WULF', 1083301, 'TeraWulf', 'hosting'),
]

interface Counterparty {
  /** The name a row carries. */
  name: string
  /** Every spelling a document uses, the name included. Matched case-sensitively on word boundaries. */
  spellings: readonly string[]
  ticker: string | null
  lab: LabId | null
  /** The filer this counterparty is, whose own documents don't search for it. */
  self?: string
}

/** The labs and clouds a passage ties a supplier to. A name outside this list keeps no ticker or lab. */
export const COUNTERPARTIES: readonly Counterparty[] = [
  { name: 'OpenAI', spellings: ['OpenAI'], ticker: null, lab: 'openai' },
  { name: 'Anthropic', spellings: ['Anthropic'], ticker: null, lab: 'anthropic' },
  { name: 'xAI', spellings: ['xAI', 'X.AI'], ticker: null, lab: 'xai' },
  { name: 'Mistral AI', spellings: ['Mistral AI', 'Mistral'], ticker: null, lab: 'mistral' },
  { name: 'DeepSeek', spellings: ['DeepSeek'], ticker: null, lab: 'deepseek' },
  { name: 'Moonshot AI', spellings: ['Moonshot AI', 'Moonshot'], ticker: null, lab: 'moonshot' },
  { name: 'Alibaba', spellings: ['Alibaba'], ticker: 'BABA', lab: 'alibaba' },
  { name: 'Google', spellings: ['Google', 'Alphabet'], ticker: 'GOOGL', lab: 'google' },
  { name: 'Meta', spellings: ['Meta Platforms', 'Meta'], ticker: 'META', lab: 'meta' },
  { name: 'Microsoft', spellings: ['Microsoft'], ticker: 'MSFT', lab: null },
  {
    name: 'Amazon',
    spellings: ['Amazon Web Services', 'Amazon.com', 'Amazon', 'AWS'],
    ticker: 'AMZN',
    lab: null,
  },
  { name: 'Oracle', spellings: ['Oracle'], ticker: 'ORCL', lab: null },
  { name: 'Nvidia', spellings: ['NVIDIA', 'Nvidia'], ticker: 'NVDA', lab: null, self: 'NVDA' },
  {
    name: 'AMD',
    spellings: ['Advanced Micro Devices', 'AMD'],
    ticker: 'AMD',
    lab: null,
    self: 'AMD',
  },
  { name: 'CoreWeave', spellings: ['CoreWeave'], ticker: 'CRWV', lab: null, self: 'CRWV' },
  { name: 'Dell', spellings: ['Dell'], ticker: 'DELL', lab: null, self: 'DELL' },
  { name: 'Fluidstack', spellings: ['Fluidstack', 'FluidStack'], ticker: null, lab: null },
]

/**
 * The legal-form words a filing writes after a name ("Google LLC", "Anthropic, PBC", "Alibaba
 * Group Holding Limited"). Only whole trailing words go, so "Meta Materials" stays itself.
 */
const LEGAL_FORM =
  /[\s,]+(?:inc|incorporated|corp|corporation|co|company|llc|l\.l\.c|ltd|limited|plc|p\.l\.c|pbc|lp|l\.p|llp|gmbh|ag|sa|s\.a|sas|s\.a\.s|se|nv|n\.v|bv|b\.v|pte|kk|opco|holdings?|group)\.?$/i

/** A name as a counterparty key: lowercase, no leading "The", no legal-form words, no stray punctuation. */
export function nameKey(name: string): string {
  let key = name
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the\s+/i, '')
  for (;;) {
    const next = key.replace(LEGAL_FORM, '').replace(/[\s,.]+$/, '')
    if (next === key || next === '') return key.toLowerCase()
    key = next
  }
}

const BY_NAME = new Map(
  COUNTERPARTIES.flatMap((c) => [c.name, ...c.spellings].map((n) => [nameKey(n), c] as const)),
)

/** The counterparty a name or one of its spellings is, legal-form words aside, or null. */
export const counterpartyNamed = (name: string): Counterparty | null =>
  BY_NAME.get(nameKey(name)) ?? null
