import { OfferingRow, type Provenance } from '#layers/core/server/utils/contracts'
import { cellText, type RegistrationTarget } from './filing-index'

// The offering terms on a registration filing's cover. An S-1's original leaves
// the price range blank ("between $ and $ ."), and the amendment that sets it
// launches the roadshow, so a blank is null; a cover with no range or price
// sentence yields no row, since a row of nulls would read as "blank".

/** Generous: Anthropic's facing page and cover end near byte 105,000. */
const COVER_BYTES = 200_000

const AMOUNT = String.raw`\$\s*(\d[\d,]*(?:\.\d+)?)?`
const RANGE = new RegExp(
  String.raw`offering price per share will be between ${AMOUNT}\s*and ${AMOUNT}\s*\.`,
  'i',
)
const PRICE = /initial public offering price (?:per share )?(?:is|of) \$\s*(\d[\d,]*(?:\.\d+)?)/i
const AMENDMENT = /AMENDMENT NO\.\s*(\d+)\s+TO\s+FORM\b/i
const LISTING =
  /on the ((?:Nasdaq|New York Stock Exchange|NYSE)[A-Za-z ]*?) under the symbol “([A-Z][A-Z.]*?)\.?”/

const usd = (s: string | undefined) => (s ? Number(s.replace(/,/g, '')) : null)

export function parseProspectusOffering(
  html: string,
  target: RegistrationTarget,
  cik: string,
  entityName: string,
  prov: Provenance,
): OfferingRow | null {
  const text = cellText(html.slice(0, COVER_BYTES))
  const range = text.match(RANGE)
  const price = text.match(PRICE)
  if (!range && !price) return null
  const low = usd(range?.[1])
  const high = usd(range?.[2])
  if ((low === null) !== (high === null)) throw new Error('price range states one bound only')
  const listing = text.match(LISTING)
  const amendment = text.match(AMENDMENT)
  return OfferingRow.parse({
    provider: target.provider,
    cik,
    entity_name: entityName,
    accession_no: target.accession_no,
    form: target.form,
    filed: target.filed,
    amendment_no: amendment ? Number(amendment[1]) : null,
    price_low: low,
    price_high: high,
    price: usd(price?.[1]),
    exchange: listing?.[1]?.trim() ?? null,
    symbol: listing?.[2] ?? null,
    ...prov,
  })
}
