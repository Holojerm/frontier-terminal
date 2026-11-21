// The payload behind the parents' panel, read from the investee recipes
// (layers/companies/server/utils/terminal-parents.ts).

export interface ParentFact {
  key: string
  label: string
  /** YYYY-MM-DD: the period end, or the instant. */
  date: string
  /** "3 months", "9 months", "instant". */
  span: string
  value: number | null
  unit: 'usd' | 'pure' | 'shares' | 'text'
  text: string | null
}

export interface ParentsData {
  as_of: string | null
  parents: {
    recipe_id: string
    lab: LabId
    parent: string
    member: string
    /** The newest period end in the filing. */
    period: string
    facts: ParentFact[]
    source: RecipeCitation
  }[]
  caveat: string
}

/** "EquityMethodInvestmentOwnershipPercentage" → "Equity method investment ownership percentage". */
export function humanizeConcept(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
  return words.charAt(0) + words.slice(1).toLowerCase()
}
