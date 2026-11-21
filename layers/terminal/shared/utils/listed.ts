// Every listed company the site's company tables name, one row each (GET /api/listed, the
// /dependencies page, the get_listed_companies MCP tool): the filers on the dependency
// graph, the chip and compute suppliers, the companies that power or host a lab's sites,
// and the hardware makers whose monthly prints /compute reads. Nothing here is new data:
// each tie points back at the table that holds its figures and quotes.

/** A filer on the graph: the lines its own XBRL draws to another company. */
export interface ListedGraphTie {
  source: 'graph'
  /** The names of the customers its filing puts a backlog, revenue or receivable on. */
  sells_to: string[]
  /** The names of the labs its filing puts a commitment, credit line or stake on. */
  funds: string[]
  /** How many filed figures those lines carry. */
  figures: number
}

/** A supplier: what the passages in its own filings say, by relation. */
export interface ListedSupplierTie {
  source: 'suppliers'
  layer: SupplierLayer
  named: { relation: Exclude<SupplierRelation, 'concentration'>; names: string[] }[]
  /** Passages that give a share for a customer the filing doesn't name. */
  unnamed: number
  passages: number
}

/** A company a cited page ties to a site Epoch AI credits to a lab. */
export interface ListedPowerTie {
  source: 'power'
  roles: PowerRole[]
  sites: string[]
}

/** A company whose monthly revenue or exports /hardware#prints reads, with its quoted ties. */
export interface ListedPrintTie {
  source: 'prints'
  layer: SupplierLayer
  /** Whether its own monthly figures are read (a Taiwan filer), or it is a member of a country series. */
  reads: 'revenue' | 'member'
  named: { relation: 'customer' | 'partner'; names: string[] }[]
  quotes: number
}

export type ListedTie = ListedGraphTie | ListedSupplierTie | ListedPowerTie | ListedPrintTie

export interface ListedCompany {
  ticker: string
  company: string
  /** The tracked lab the company is or owns. */
  lab: string | null
  /** The tracked labs a filing names with it: a line on the graph, or a passage in its own filing. */
  labs: string[]
  /**
   * The tracked labs Epoch AI credits with a site it powers or hosts. A tie
   * by site and by Epoch's estimate, so it is kept apart from `labs`.
   */
  site_labs: string[]
  /** One per table that names it, in the order graph, suppliers, power. */
  ties: ListedTie[]
}

export interface ListedData {
  as_of: string | null
  computed_at: string
  rule: string
  /** The graph's filers, then suppliers by what they sell, then the power companies. */
  companies: ListedCompany[]
  counts: {
    companies: number
    graph: number
    suppliers: number
    power: number
    prints: number
    /** Companies that are a tracked lab's parent, or that a source ties to one by name or by site. */
    lab_tied: number
  }
}

const list = (names: string[]) =>
  names.length < 3
    ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** What the company is, in a few words, from the tables that name it. */
export function listedGroup(c: ListedCompany): string {
  const labels = c.ties.map((t) => {
    // The graph's filers are the clouds and the labs' listed parents.
    if (t.source === 'graph')
      return c.lab ? 'Lab parent' : t.funds.length ? 'Cloud and funder' : 'Cloud'
    if (t.source === 'suppliers' || t.source === 'prints') return SUPPLIER_LAYER_LABEL[t.layer]
    return t.roles.map((r) => POWER_ROLE_LABEL[r]).join(', ')
  })
  return [...new Set(labels)].join(', ')
}

/** One tie as a sentence a reader can check against the table it links to. */
export function listedTieText(
  tie: ListedTie,
  c: Pick<ListedCompany, 'company' | 'lab' | 'site_labs'>,
): string {
  if (tie.source === 'graph') {
    const parts = [
      // Meta files as itself; Alphabet files for Google.
      c.lab ? (labName(c.lab) === c.company ? 'Is a tracked lab' : `Owns ${labName(c.lab)}`) : '',
      tie.sells_to.length ? `Sells to ${list(tie.sells_to)}` : '',
      tie.funds.length ? `Funds ${list(tie.funds)}` : '',
    ].filter(Boolean)
    if (tie.sells_to.length + tie.funds.length === 0) {
      parts.push(`The figures we read from its filings name no ${c.lab ? 'other lab' : 'lab'}`)
    }
    return `${parts.join('. ')}.`
  }
  if (tie.source === 'suppliers') {
    const parts = tie.named.map(
      (n) => `${capital(SUPPLIER_RELATION_LABEL[n.relation])} ${list(n.names)}`,
    )
    if (tie.unnamed) {
      // "Share" alone would read as stock beside "issued shares or warrants".
      const unnamed = `${tie.unnamed} ${tie.unnamed === 1 ? 'passage gives' : 'passages give'} a share of revenue for a customer it doesn’t name`
      parts.push(parts.length ? unnamed : `Its filings name no other company. ${unnamed}`)
    }
    return `${parts.join('. ')}.`
  }
  if (tie.source === 'prints') {
    const label = { customer: 'Builds for or supplies', partner: 'Named as a partner of' } as const
    const parts = tie.named.map((n) => `${label[n.relation]} ${list(n.names)}`)
    if (tie.reads === 'revenue') parts.push('Its monthly revenue is read')
    return `${parts.join('. ')}.`
  }
  const roles = capital(list(tie.roles.map((r) => POWER_ROLE_LABEL[r].toLowerCase())))
  const sites = tie.sites.length === 1 ? 'a site' : 'sites'
  return `${roles} at ${list(tie.sites)}, ${sites} Epoch AI credits to ${list(c.site_labs.map(labName))}.`
}

/** Where a tie's figures and quotes are, and how many of them. */
export function listedEvidence(tie: ListedTie): { text: string; to: string } {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  if (tie.source === 'graph') {
    return tie.figures
      ? { text: count(tie.figures, 'filed figure', 'filed figures'), to: '/dependencies#lines' }
      : { text: 'Its own filed sizes', to: '/dependencies#sizes' }
  }
  if (tie.source === 'suppliers') {
    return {
      text: count(tie.passages, 'filed passage', 'filed passages'),
      to: '/dependencies#suppliers',
    }
  }
  if (tie.source === 'prints') {
    return { text: count(tie.quotes, 'quoted tie', 'quoted ties'), to: '/hardware#prints' }
  }
  return { text: count(tie.sites.length, 'site', 'sites'), to: '/power#suppliers' }
}

/** Some of the rows, with the counts of that set. Every row in it is tied to a lab. */
export function listedSubset(data: ListedData, companies: ListedCompany[]): ListedData {
  const from = (source: ListedTie['source']) =>
    companies.filter((c) => c.ties.some((t) => t.source === source)).length
  return {
    ...data,
    companies,
    counts: {
      companies: companies.length,
      graph: from('graph'),
      suppliers: from('suppliers'),
      power: from('power'),
      prints: from('prints'),
      lab_tied: companies.length,
    },
  }
}

/** The companies tied to both labs: rows of one lab's cut whose ticker is in the other's. */
export function listedBoth(a: ListedData, b: ListedData): ListedData {
  const tickers = new Set(b.companies.map((c) => c.ticker))
  return listedSubset(
    a,
    a.companies.filter((c) => tickers.has(c.ticker)),
  )
}
