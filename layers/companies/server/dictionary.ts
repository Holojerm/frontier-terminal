// The companies layer's tables in the data dictionary: what each export cannot say about itself.
// Part of DICTIONARY_ENTRIES (server/registries/dictionary.ts).

const { byProvider, entityId: ID } = DICTIONARY_COMMON

const SEC_FEEDS = 'Every 30 minutes with the SEC feeds, and again every 6 hours.'
const sec: DictionaryFeed = { axes: ['sec'] }
const byCik: DictionaryJoin = { column: 'cik', to: 'entity_identifiers.cik' }
const byTicker: DictionaryJoin = { column: 'ticker', to: 'entity_identifiers.ticker' }
const prospectus = (grain: string): DictionaryEntry => ({
  grain,
  cadence: SEC_FEEDS,
  event: 'filed',
  knowledge: 'first_seen_at',
  start: 'From each lab’s first registration filing we read (Anthropic’s S-1 of 2026-10-26).',
  joins: [byProvider, byCik],
  feeds: [sec],
})

export const COMPANIES_DICTIONARY: Readonly<Record<string, DictionaryEntry>> = {
  filers: {
    grain: 'One row per lab whose CIK we found in its own registration filing.',
    cadence: SEC_FEEDS,
    event: 'resolved_file_date',
    knowledge: 'first_seen_at',
    start: 'From the first registration filing we found for each lab.',
    joins: [byProvider, byCik],
    feeds: [sec],
  },
  revenue_facts: {
    grain: 'One row per XBRL revenue fact per filing.',
    cadence:
      'Company facts every 30 minutes with the SEC feeds. Segment revenue from each 10-Q and 10-K every 6 hours.',
    event: 'end',
    knowledge: 'first_seen_at',
    start: 'Every revenue fact in EDGAR company facts, as far back as each filer tagged it.',
    joins: [byProvider, byCik],
    feeds: [{ axes: ['revenue'] }],
  },
  prospectus_statements: prospectus('One row per filing, period, and statement line.'),
  prospectus_commitments: prospectus('One row per filing, schedule line, and year bucket.'),
  prospectus_concentration: prospectus('One row per filing, basis, customer, and period.'),
  prospectus_shares: prospectus('One row per filing and share-count line.'),
  prospectus_risk_factors: prospectus('One row per filing and risk-factor heading.'),
  filed_facts: {
    grain: 'One row per XBRL fact per filing.',
    cadence: 'Every 30 minutes. Company facts every 6 hours.',
    event: 'end',
    knowledge: 'filed',
    cut: 'Rows whose filing date is before the UTC day of as_of. A fact counts from the day after its filing, whenever we read it, so this table answers as_of back to 2019.',
    start:
      'Company facts as far back as the filer tagged them, and each 10-Q and 10-K instance from 2020.',
    joins: [byTicker, byCik],
    feeds: ['filed_facts'],
  },
  filed_text_facts: {
    grain: 'One row per figure a filing states about a lab in words, per filing.',
    cadence:
      'Read once: Amazon’s 10-Qs and 10-Ks from 2023-10-27 to 2026-02-06, a few a run of the filed-facts reader.',
    event: 'end',
    knowledge: 'filed',
    cut: 'Rows whose filing date is before the UTC day of as_of. A figure counts from the day after its filing, whenever we read it, so this table answers as_of back to 2023-10.',
    start:
      'Amazon’s 10-Q for the quarter to 2023-09-30, the first to name Anthropic, to its 10-K for 2025. From its 10-Q of 2026-04-30 Amazon tags Anthropic (filed_facts).',
    joins: [byTicker, byCik],
    feeds: ['filed_facts'],
  },
  filed_guidance: {
    grain:
      'One row per figure: a release’s capex for a fiscal year (source release), or a metric and period a call document guides.',
    cadence:
      'Release capex every 30 minutes with the filed-facts read. Call documents hourly, up to eight a run; a replay the run after AssemblyAI finishes it.',
    event: 'filed',
    knowledge: 'filed',
    cut: 'Rows whose release or call was filed or held before the UTC day of as_of. A figure counts from the day after it was stated, whenever we read it, so this table answers as_of back to 2024 for the release capex and to 2018 for the calls.',
    start:
      'Release capex from 2024-01-01; the calls of the 45 listed companies from 2018, as each company’s filings and posted files reach.',
    joins: [byTicker, byCik],
    feeds: ['filed_facts', 'calls'],
  },
  guidance_resolutions: {
    grain: 'One row per call guidance row a later filing settled.',
    cadence: 'Hourly, once the guided period’s 10-Q or 10-K is in XBRL.',
    event: 'filed',
    knowledge: 'first_seen_at',
    cut: 'Rows with first_seen_at at or before as_of: a guided figure as settled by what we held then.',
    start: 'Guidance from calls held from 2018, as each company’s filings and posted files reach.',
    joins: [byTicker],
    feeds: ['filed_facts'],
  },
  call_documents: {
    grain: 'One row per document or replay an earnings call is read from.',
    cadence:
      'Hourly: new EDGAR exhibits for three companies a run, and every curated document once.',
    event: 'call_date',
    knowledge: 'first_seen_at',
    cut: 'Rows with first_seen_at at or before as_of.',
    start: 'Calls held from 2018, as each company’s filings and posted files reach.',
    joins: [byTicker],
    feeds: ['calls', 'filed_facts'],
  },
  exposure_quarters: {
    grain: 'One row per series and period.',
    cadence: 'Rebuilt from filed_facts on each request.',
    event: 'end',
    knowledge: 'filed',
    cut: 'Built from the filed_facts rows filed before the UTC day of as_of, so it answers back to 2019.',
    start: 'From 2020.',
    joins: [byTicker],
    feeds: ['filed_facts'],
  },
  dependency_edges: {
    grain: 'One row per figure on a line of the dependency graph.',
    cadence: 'Rebuilt from filed_facts on each request.',
    event: 'end',
    knowledge: 'filed',
    cut: 'Built from the filed_facts rows filed before the UTC day of as_of: the graph as the filings stood then.',
    start: 'The newest filed figure of each series only. Earlier periods are in exposure_quarters.',
    joins: [{ column: 'reporter', to: 'entity_identifiers.ticker' }],
    feeds: ['filed_facts'],
  },
  entity_securities: {
    grain: 'One row per tracked company and security that carries it (or none).',
    cadence: 'By hand, when a mapping changes.',
    event: null,
    knowledge: 'checked_on',
    start: 'The current mapping only.',
    joins: [
      { column: 'entity', to: ID },
      { column: 'cik', to: 'entity_identifiers.cik' },
      { column: 'figi', to: 'your security master' },
    ],
    feeds: [{ ids: ['sec-identifiers', 'openfigi-mapping'] }],
    licenseNote: 'figi and mic come from OpenFIGI. Everything else comes from SEC filings.',
  },
  entity_identifiers: {
    grain: 'One row per company we name.',
    cadence: 'By hand, when a company’s identifiers change.',
    event: null,
    knowledge: 'fetched_at',
    start: 'The current registry only.',
    joins: [
      { column: 'cik', to: 'your security master' },
      { column: 'lei', to: 'your security master' },
      { column: 'figi', to: 'your security master' },
      { column: 'ticker', to: 'your security master' },
    ],
    feeds: ['identifiers'],
    licenseNote:
      'CIK, ticker, and exchange come from SEC, lei from GLEIF, and figi and mic from OpenFIGI. legal_name and country come from GLEIF too, except on a row with no LEI, where they come from the company’s own terms page.',
  },
  supplier_passages: {
    grain: 'One row per passage in a company’s own SEC document that ties it to a lab or a cloud.',
    cadence:
      'Six-hourly. The filings lane reads each company’s new filings and the judge reads the passages from them; a row ends when the next filing of its form drops the quote.',
    event: 'filed',
    knowledge: 'fetched_at',
    start: 'The hand read of 2026-11-19 and 2026-11-20, then every filing since.',
    joins: [
      { column: 'counterparty_lab', to: ID },
      { column: 'ticker', to: 'your security master' },
    ],
    feeds: [{ ids: ['edgar-submissions'] }],
  },
}
