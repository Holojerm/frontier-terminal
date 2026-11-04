// Which securities carry each tracked lab and filer: the table a fund joins
// this data to its own book with. Four of the six labs are private, so most
// rows say how a lab reaches a listed security (a parent, a disclosed
// investor) or that none does.
//
// Every CIK is one sources.yaml already holds (cik_whitelist, recipe_sources,
// or a filer resolved from its own S-1), and every symbol and exchange is the
// one EDGAR's submissions feed lists for that CIK (fixtures/sec/).
// layers/terminal/test/terminal-entities.test.ts fails when a row stops
// matching either. Nothing here is typed in from memory: a filer the terminal
// reads no filing from (Oracle, for one) has no row.

export const ENTITY_SECURITY_COLUMNS = [
  'entity',
  'entity_name',
  'entity_kind',
  'relationship',
  'issuer',
  'cik',
  'symbol',
  'exchange',
  'listing_status',
  'note',
  'source_url',
  'checked_on',
] as const

type Column = (typeof ENTITY_SECURITY_COLUMNS)[number]

export interface EntitySecurity extends Record<Column, string | null> {
  entity_kind: 'lab' | 'filer'
  /**
   * self: the entity is the issuer, or part of it. parent: a public parent
   * consolidates it. investor: the issuer discloses a stake in the entity.
   * none: no security carries it.
   */
  relationship: 'self' | 'parent' | 'investor' | 'none'
  /** listed: trading. registered: an S-1 is on file, not yet trading. private: no security. */
  listing_status: 'listed' | 'registered' | 'private'
  source_url: string
  checked_on: string
}

const CHECKED = '2026-11-04'
const submissions = (cik: string) => `https://data.sec.gov/submissions/CIK${cik}.json`

export const ENTITY_SECURITIES: readonly EntitySecurity[] = [
  {
    entity: 'anthropic',
    entity_name: 'Anthropic',
    entity_kind: 'lab',
    relationship: 'self',
    issuer: 'Anthropic, PBC',
    cik: '0002130357',
    symbol: 'ANT',
    exchange: 'Nasdaq Global Select Market',
    listing_status: 'registered',
    note: 'Proposed symbol, not trading: the S-1 of 2026-10-26 says Anthropic has applied to list its Class A common stock on the Nasdaq Global Select Market under the symbol “ANT.” CIK resolved from that filing (export filers).',
    source_url:
      'https://www.sec.gov/Archives/edgar/data/2130357/000162828026067168/anthropicpbc-sx1.htm',
    checked_on: CHECKED,
  },
  {
    entity: 'anthropic',
    entity_name: 'Anthropic',
    entity_kind: 'lab',
    relationship: 'investor',
    issuer: 'AMAZON COM INC',
    cik: '0001018724',
    symbol: 'AMZN',
    exchange: 'Nasdaq',
    listing_status: 'listed',
    note: 'Amazon tags its Anthropic investment on amzn:AnthropicMember in its 10-Q and 10-K (recipe sec-amzn-anthropic). Exposure, not a proxy: Amazon’s numbers, not Anthropic’s. Alphabet’s stake is not mapped because its filings never name the investee (sources.yaml cut alphabet-anthropic-stake).',
    source_url: submissions('0001018724'),
    checked_on: CHECKED,
  },
  {
    entity: 'openai',
    entity_name: 'OpenAI',
    entity_kind: 'lab',
    relationship: 'none',
    issuer: null,
    cik: null,
    symbol: null,
    exchange: null,
    listing_status: 'private',
    note: 'No EDGAR filer. An S-1 filed under its own name resolves its CIK at poll time (sources.yaml pending_filers) and adds a row to export filers.',
    source_url: 'https://efts.sec.gov/LATEST/search-index?q=%22OpenAI%22&forms=S-1',
    checked_on: CHECKED,
  },
  {
    entity: 'openai',
    entity_name: 'OpenAI',
    entity_kind: 'lab',
    relationship: 'investor',
    issuer: 'MICROSOFT CORP',
    cik: '0000789019',
    symbol: 'MSFT',
    exchange: 'Nasdaq',
    listing_status: 'listed',
    note: 'Microsoft tags its OpenAI interest on msft:OpenAIGlobalLlcMember in its 10-Q and 10-K (recipe sec-msft-openai). Microsoft’s numbers, not OpenAI’s.',
    source_url: submissions('0000789019'),
    checked_on: CHECKED,
  },
  {
    entity: 'google',
    entity_name: 'Google',
    entity_kind: 'lab',
    relationship: 'parent',
    issuer: 'Alphabet Inc.',
    cik: '0001652044',
    symbol: 'GOOGL',
    exchange: 'Nasdaq',
    listing_status: 'listed',
    note: 'Alphabet reports no Gemini line; the nearest audited figure is the Google Cloud segment (export revenue_facts). EDGAR lists GOOGL, GOOG, GOOGM and GOOGN for this CIK.',
    source_url: submissions('0001652044'),
    checked_on: CHECKED,
  },
  {
    entity: 'google',
    entity_name: 'Google',
    entity_kind: 'lab',
    relationship: 'parent',
    issuer: 'Alphabet Inc.',
    cik: '0001652044',
    symbol: 'GOOG',
    exchange: 'Nasdaq',
    listing_status: 'listed',
    note: 'Same issuer as GOOGL.',
    source_url: submissions('0001652044'),
    checked_on: CHECKED,
  },
  {
    entity: 'meta',
    entity_name: 'Meta',
    entity_kind: 'lab',
    relationship: 'self',
    issuer: 'Meta Platforms, Inc.',
    cik: '0001326801',
    symbol: 'META',
    exchange: 'Nasdaq',
    listing_status: 'listed',
    note: 'The lab is part of the issuer, whose segments are Family of Apps and Reality Labs, never the model API.',
    source_url: submissions('0001326801'),
    checked_on: CHECKED,
  },
  {
    entity: 'xai',
    entity_name: 'xAI',
    entity_kind: 'lab',
    relationship: 'parent',
    issuer: 'SPACE EXPLORATION TECHNOLOGIES CORP',
    cik: '0001181412',
    symbol: 'SPCX',
    exchange: 'Nasdaq',
    listing_status: 'listed',
    note: 'A blend: SpaceX is xAI’s parent since the 2025 merger and files as one registrant, so SPCX carries launch and Starlink with xAI, and its revenue is the parent’s consolidated figure. The xAI hiring board is entity-blended too (company_name SpaceXAI).',
    source_url: submissions('0001181412'),
    checked_on: CHECKED,
  },
  {
    entity: 'mistral',
    entity_name: 'Mistral',
    entity_kind: 'lab',
    relationship: 'none',
    issuer: null,
    cik: null,
    symbol: null,
    exchange: null,
    listing_status: 'private',
    note: 'No EDGAR filer. “Mistral AI” appears in S-1-family filings only as a CoreWeave customer (two S-1/A, March 2025).',
    source_url: 'https://efts.sec.gov/LATEST/search-index?q=%22Mistral%20AI%22&forms=S-1,S-1/A',
    checked_on: CHECKED,
  },
  {
    entity: 'microsoft',
    entity_name: 'Microsoft',
    entity_kind: 'filer',
    relationship: 'self',
    issuer: 'MICROSOFT CORP',
    cik: '0000789019',
    symbol: 'MSFT',
    exchange: 'Nasdaq',
    listing_status: 'listed',
    note: 'Whitelisted filer (sources.yaml cik_whitelist): its filings are alerted, and its OpenAI facts are read (recipe sec-msft-openai). Azure GPU list prices come from recipe gpu-azure.',
    source_url: submissions('0000789019'),
    checked_on: CHECKED,
  },
  {
    entity: 'amazon',
    entity_name: 'Amazon',
    entity_kind: 'filer',
    relationship: 'self',
    issuer: 'AMAZON COM INC',
    cik: '0001018724',
    symbol: 'AMZN',
    exchange: 'Nasdaq',
    listing_status: 'listed',
    note: 'Whitelisted filer (sources.yaml cik_whitelist): its filings are alerted, and its Anthropic facts are read (recipe sec-amzn-anthropic).',
    source_url: submissions('0001018724'),
    checked_on: CHECKED,
  },
  {
    entity: 'nvidia',
    entity_name: 'NVIDIA',
    entity_kind: 'filer',
    relationship: 'self',
    issuer: 'NVIDIA CORP',
    cik: '0001045810',
    symbol: 'NVDA',
    exchange: 'Nasdaq',
    listing_status: 'listed',
    note: 'Whitelisted filer (sources.yaml cik_whitelist): its filings are alerted. No lab relationship is mapped.',
    source_url: submissions('0001045810'),
    checked_on: CHECKED,
  },
  {
    entity: 'coreweave',
    entity_name: 'CoreWeave',
    entity_kind: 'filer',
    relationship: 'self',
    issuer: 'CoreWeave, Inc.',
    cik: '0001769628',
    symbol: 'CRWV',
    exchange: null,
    listing_status: 'listed',
    note: 'GPU-rental comparable on the Compute thesis: revenue from company facts (recipe sec-revenue-crwv), list prices from recipe gpu-coreweave. Issuer name and symbol as EDGAR full-text search prints them; no submissions feed is read, so no exchange is stated.',
    source_url: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0001769628.json',
    checked_on: CHECKED,
  },
]
