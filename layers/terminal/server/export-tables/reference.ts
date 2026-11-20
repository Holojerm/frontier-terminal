// The feed's own run log, and the registries kept in code: the entity registries and the
// passages read by hand (suppliers, power-site ties). Part of EXPORT_TABLES
// (utils/terminal-export.ts), which fixes the order.

import { curatedPowerSites } from '../../shared/utils/power-sites'
import curatedPower from '../curated/power-sites.json'
import { contentHash } from '../pipeline/contracts/keys'
import { ENTITY_SECURITIES, ENTITY_SECURITY_COLUMNS } from '../utils/terminal-entities'
import { ENTITY_IDENTIFIERS, ENTITY_IDENTIFIER_COLUMNS } from '../utils/terminal-identifiers'
import { buildSuppliers } from '../utils/terminal-suppliers'
import * as tables from '#server/db/schema'
import {
  CIK,
  SOURCE_NAME,
  plainTable,
  staticTable,
  byColumn,
  loggedTotal,
  type ExportTable,
} from '../utils/terminal-export-views'

const SUPPLIER_PASSAGE_COLUMNS = [
  'id',
  'ticker',
  'company_name',
  'layer',
  'relation',
  'counterparty',
  'counterparty_ticker',
  'counterparty_lab',
  'figures',
  'form',
  'filed',
  'period',
  'source_title',
  'quote',
  'alias_term',
  'alias_quote',
  'source_url',
  'fetched_at',
] as const

/** Every passage, in the order /api/suppliers lists them. */
const SUPPLIER_PASSAGES = buildSuppliers().rows.map((r) => ({
  id: contentHash({
    ticker: r.ticker,
    relation: r.relation,
    counterparty: r.counterparty,
    source_url: r.source_url,
    quote: r.quote,
  }),
  ticker: r.ticker,
  company_name: r.company,
  layer: r.layer,
  relation: r.relation,
  counterparty: r.counterparty,
  counterparty_ticker: r.counterparty_ticker,
  counterparty_lab: r.counterparty_lab,
  figures: r.figures,
  form: r.form,
  filed: r.filed,
  period: r.period,
  source_title: r.source_title,
  quote: r.quote,
  alias_term: r.alias?.term ?? null,
  alias_quote: r.alias?.quote ?? null,
  source_url: r.source_url,
  fetched_at: r.fetched_at,
}))

const POWER_SITE_TIE_COLUMNS = [
  'id',
  'site',
  'role',
  'company_name',
  'parent',
  'ticker',
  'unlisted',
  'mw',
  'mw_meaning',
  'source_title',
  'publisher',
  'published',
  'quote',
  'source_url',
  'fetched_at',
] as const

/** Per site, the grid where a page names it, then each company in the order the file lists them. */
const POWER_SITE_TIES = curatedPowerSites.parse(curatedPower).sites.flatMap((s) => {
  const id = (role: string, company: string, source_url: string, quote: string) =>
    contentHash({ site: s.site, role, company, source_url, quote })
  const grid = s.grid
    ? [
        {
          id: id('grid', s.grid.name, s.grid.source_url, s.grid.quote),
          site: s.site,
          role: 'grid',
          company_name: s.grid.name,
          parent: null,
          ticker: null,
          unlisted: null,
          mw: null,
          mw_meaning: null,
          source_title: null,
          publisher: null,
          published: null,
          quote: s.grid.quote,
          source_url: s.grid.source_url,
          fetched_at: s.grid.fetched_at,
        },
      ]
    : []
  return [
    ...grid,
    ...s.links.map((l) => ({
      id: id(l.role, l.company, l.source_url, l.quote),
      site: s.site,
      role: l.role,
      company_name: l.company,
      parent: l.parent,
      ticker: l.ticker,
      unlisted: l.unlisted,
      mw: l.mw,
      mw_meaning: l.mw_meaning,
      source_title: l.source_title,
      publisher: l.publisher,
      published: l.published,
      quote: l.quote,
      source_url: l.source_url,
      fetched_at: l.fetched_at,
    })),
  ]
})

const HAND_READ = (check: string) =>
  `it’s read by hand and kept in code, and each row is dated by when ${check} last found its quote (fetched_at).`

export const REFERENCE_TABLES = {
  source_runs: plainTable(
    'source_runs',
    'One row per check of each source, with what we tried and what happened. There’s no fetched_at column, since a failed run fetched nothing.',
    tables.sourceRuns,
    {
      id: { type: 'text', key: true, meaning: 'The run: <scope>:<source_id>:<started_at>.' },
      scope: {
        type: 'text',
        meaning:
          'Which poll ran it: edgar, survey, careers (the large careers feeds, on a six-hourly tick of their own), filings (the registration filings, likewise), or tripwire (an off-cycle poll of the model catalogs).',
      },
      source_id: SOURCE_NAME,
      started_at: {
        type: 'timestamp',
        provenance: true,
        meaning:
          'When the check started, in UTC. It stands in for fetched_at, since a failed run fetched nothing.',
      },
      status: {
        type: 'text',
        meaning:
          'ok, unchanged, failed, baseline (a first fetch, nothing to compare), skipped (the source needs a credential this deploy lacks), or absent (a URL derived from a stored row returned 404).',
      },
      detail: {
        type: 'text',
        nullable: true,
        meaning: 'What happened, in words: the error, or a count such as “104 entities”.',
      },
      snapshot_id: {
        type: 'text',
        nullable: true,
        meaning: 'The snapshots.id the run fetched. Null when no fetch succeeded.',
      },
      added: { type: 'integer', unit: 'rows', meaning: 'Rows the run logged as added.' },
      removed: { type: 'integer', unit: 'rows', meaning: 'Rows the run logged as removed.' },
      modified: { type: 'integer', unit: 'rows', meaning: 'Rows the run logged as modified.' },
      source_url: { type: 'text', provenance: true, meaning: 'The URL attempted.' },
    },
    [tables.sourceRuns.started_at, tables.sourceRuns.id],
    byColumn(tables.sourceRuns.started_at),
    loggedTotal(tables.sourceStats.run_count),
  ),
  entity_securities: staticTable(
    'entity_securities',
    'Each lab and SEC filer we track, mapped to the securities that carry it. Each row has the issuer, CIK, symbol, and exchange as EDGAR lists them, how the lab or filer relates to the security (itself, its parent, a disclosed investor), and the row’s source. A private lab with no security has a row saying so.',
    ENTITY_SECURITY_COLUMNS,
    {
      entity: {
        type: 'text',
        key: true,
        meaning: 'The lab or filer id (anthropic, microsoft, …), as the rest of the site uses it.',
      },
      entity_name: { type: 'text', meaning: 'The lab’s or filer’s name.' },
      entity_kind: {
        type: 'text',
        meaning: 'lab (one of the nine) or filer (a company whose filings the site reads).',
      },
      relationship: {
        type: 'text',
        meaning:
          'self (the entity is the issuer or part of it), parent (a public parent consolidates it), investor (the issuer discloses a stake in it), or none (no security carries it).',
      },
      issuer: {
        type: 'text',
        nullable: true,
        meaning: 'The issuer as EDGAR lists it. Null when no security carries the entity.',
      },
      cik: {
        ...CIK,
        nullable: true,
        meaning: 'The issuer’s SEC CIK, ten digits. Null with no issuer.',
      },
      symbol: {
        type: 'text',
        key: true,
        nullable: true,
        meaning:
          'The symbol as EDGAR lists it, or the proposed one for a registered issuer. Null with no security.',
      },
      exchange: {
        type: 'text',
        nullable: true,
        meaning: 'The exchange as EDGAR lists it. Null where no submissions feed is read.',
      },
      listing_status: {
        type: 'text',
        meaning: 'listed (trading), registered (an S-1 on file, not yet trading), or private.',
      },
      note: { type: 'text', nullable: true, meaning: 'How the mapping was made and its limits.' },
      mic: {
        type: 'text',
        nullable: true,
        meaning:
          'The ISO 10383 market identifier code OpenFIGI lists the symbol under: XNGS (Nasdaq Global Select Market) or XNYS (New York Stock Exchange). Null with no security.',
      },
      figi: {
        type: 'text',
        nullable: true,
        meaning:
          'The symbol’s US composite FIGI, from OpenFIGI. entity_identifiers has the URL and time it was read. Null with no security.',
      },
      disclosed_in: {
        type: 'text',
        nullable: true,
        meaning:
          'For a parent or investor row, the URL of the filing that discloses the relationship. Null for self and none.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The document the row was checked against.',
      },
      checked_on: {
        type: 'date',
        provenance: true,
        meaning:
          'The day the row was checked against source_url. It stands in for fetched_at, since the row is checked by hand.',
      },
    },
    ENTITY_SECURITIES,
    'it’s a hand-checked table kept in code, and each row is dated by its checked_on.',
  ),
  entity_identifiers: staticTable(
    'entity_identifiers',
    'One row per company we name: each lab, each SEC filer we read, and each comparison company. Each row has the legal name, country, CIK, LEI, and for a listed company its ticker, MIC, and FIGI. Every identifier has the URL and time we read it. entity_id is the value of every provider and company column, so this is the table to join on.',
    ENTITY_IDENTIFIER_COLUMNS,
    {
      entity_id: {
        type: 'text',
        key: true,
        meaning:
          'Our id for the company. It’s the value of provider, company, and entity_securities.entity everywhere else.',
      },
      entity_name: { type: 'text', meaning: 'The name the site uses.' },
      entity_kind: {
        type: 'text',
        meaning:
          'lab (one of the nine), filer (a company whose SEC filings we read), or company (a comparison company in a thesis).',
      },
      legal_name: {
        type: 'text',
        nullable: true,
        meaning:
          'The legal name as GLEIF records it, or as the company’s own terms page prints it when GLEIF has no record. Null where we read neither.',
      },
      country: {
        type: 'text',
        nullable: true,
        meaning:
          'ISO 3166-1 alpha-2 country of the legal entity: GLEIF’s legal-address country, else the country the company’s own page names. Null where we read neither.',
      },
      listing_status: {
        type: 'text',
        meaning:
          'listed (its own shares trade), registered (an S-1 on file, not yet trading), subsidiary (owned by a listed parent, which entity_securities names), or private.',
      },
      cik: {
        ...CIK,
        nullable: true,
        meaning: 'The SEC CIK, ten digits, zero-padded. Null for a company that doesn’t file.',
      },
      cik_source_url: {
        type: 'text',
        nullable: true,
        provenance: true,
        meaning: 'Where the CIK was read: SEC’s company_tickers_exchange.json.',
      },
      cik_fetched_at: {
        type: 'timestamp',
        nullable: true,
        provenance: true,
        meaning: 'When we read the CIK, in UTC.',
      },
      lei: {
        type: 'text',
        nullable: true,
        meaning:
          'The ISO 17442 Legal Entity Identifier, from GLEIF. Null with the reason in lei_note.',
      },
      lei_status: {
        type: 'text',
        nullable: true,
        meaning:
          'GLEIF’s registration status for the LEI (ISSUED, LAPSED, …), as of lei_fetched_at.',
      },
      lei_note: {
        type: 'text',
        meaning: 'How the LEI was matched to the company, or why there’s none.',
      },
      lei_source_url: {
        type: 'text',
        nullable: true,
        provenance: true,
        meaning:
          'The GLEIF request the LEI was read from. For a null LEI, the search that found none, where we ran one.',
      },
      lei_fetched_at: {
        type: 'timestamp',
        nullable: true,
        provenance: true,
        meaning: 'When that GLEIF request ran, in UTC.',
      },
      ticker: {
        type: 'text',
        nullable: true,
        meaning:
          'The primary symbol as EDGAR lists it, or the proposed one for a registered company. entity_securities lists every symbol we map. Null when not listed.',
      },
      exchange: {
        type: 'text',
        nullable: true,
        meaning: 'The exchange as EDGAR’s ticker file lists it. Null when EDGAR gives none.',
      },
      mic: {
        type: 'text',
        nullable: true,
        meaning:
          'The ISO 10383 market identifier code OpenFIGI lists the symbol under (XNGS or XNYS). Null when not listed.',
      },
      figi: {
        type: 'text',
        nullable: true,
        meaning: 'The symbol’s US composite FIGI, from OpenFIGI. Null when not listed.',
      },
      share_class_figi: {
        type: 'text',
        nullable: true,
        meaning: 'The share-class FIGI OpenFIGI gives with it. Null when not listed.',
      },
      figi_source_url: {
        type: 'text',
        nullable: true,
        provenance: true,
        meaning: 'The OpenFIGI mapping API the FIGIs and MIC were read from.',
      },
      figi_fetched_at: {
        type: 'timestamp',
        nullable: true,
        provenance: true,
        meaning: 'When that OpenFIGI request ran, in UTC.',
      },
      note: { type: 'text', nullable: true, meaning: 'Anything a join needs to know.' },
      source_url: {
        type: 'text',
        nullable: true,
        provenance: true,
        meaning:
          'Where legal_name and country were read: GLEIF when there’s an LEI, else the company’s own terms page.',
      },
      fetched_at: {
        type: 'timestamp',
        nullable: true,
        provenance: true,
        meaning: 'When source_url was read, in UTC.',
      },
    },
    ENTITY_IDENTIFIERS,
    'it’s a registry kept in code, and each identifier is dated by its own fetched_at.',
  ),
  supplier_passages: staticTable(
    'supplier_passages',
    'The chip, hardware, and compute-rental companies whose own SEC documents tie them to a lab or a cloud: one row per passage, read by hand and quoted, with the figures it states. A share is the filing’s own figure for one customer in the period it names, and fiscal years differ. Where a filing gives a customer’s share and no name, the row keeps the filing’s label (“Customer A”) and names no one. A row is kept only while suppliers:verify still finds its quote in the document.',
    SUPPLIER_PASSAGE_COLUMNS,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of ticker, relation, counterparty, source_url, and quote.',
      },
      ticker: { type: 'text', meaning: 'The company’s ticker, as it trades.' },
      company_name: { type: 'text', meaning: 'The company’s name.' },
      layer: {
        type: 'text',
        meaning:
          'Where the company sits: chips, memory, foundry, networking, optics, servers, cooling (power and cooling), neocloud (compute rental), or hosting (data-center hosting).',
      },
      relation: {
        type: 'text',
        meaning:
          'What the passage says the company is to the counterparty: customer (sells to it), supplier (buys from it), investment (invests in it), investor (issued it shares or warrants), guarantee (guarantees leases for it), or concentration (a customer given a share and no name).',
      },
      counterparty: {
        type: 'text',
        meaning:
          'The name the document uses. For concentration, the document’s own label, such as Customer A.',
      },
      counterparty_ticker: {
        type: 'text',
        nullable: true,
        meaning: 'The counterparty’s ticker. Null for a private lab and for concentration.',
      },
      counterparty_lab: {
        type: 'text',
        nullable: true,
        meaning:
          'The tracked lab the counterparty is or owns, as the rest of the site names it. Null for a cloud or an unnamed customer.',
      },
      figures: {
        type: 'json',
        meaning:
          'Each figure the passage states, up to three, as {value, unit, meaning}. unit is usd, pct_revenue, pct_revenue_combined (several customers together), pct_receivables, pct_backlog, shares, or gw. Empty where the passage names the counterparty and gives no number.',
      },
      form: {
        type: 'text',
        meaning: 'The document type: 10-K, 10-Q, 8-K, EX-99.1, EX-99.2, 20-F, or 6-K.',
      },
      filed: { type: 'date', meaning: 'The document’s filing date.' },
      period: {
        type: 'text',
        nullable: true,
        meaning: 'The period the document covers, in its words. Null where it names none.',
      },
      source_title: { type: 'text', meaning: 'The document, in a few words.' },
      quote: { type: 'text', meaning: 'The passage the row rests on, as the document has it.' },
      alias_term: {
        type: 'text',
        nullable: true,
        meaning:
          'Where the passage calls the counterparty by a term the document defines (“the Parent”), the term. Null otherwise.',
      },
      alias_quote: {
        type: 'text',
        nullable: true,
        meaning: 'The passage that defines alias_term. Null with no alias.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The SEC document on EDGAR the passage is in.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When suppliers:verify last fetched the document and found the quote, in UTC.',
      },
    },
    SUPPLIER_PASSAGES,
    HAND_READ('suppliers:verify'),
  ),
  power_site_ties: staticTable(
    'power_site_ties',
    'Who supplies power to the data-center sites Epoch AI ties to a lab: one row per company a public page ties to a site (the utility, a generator, an equipment maker, the site host), and one for the grid where a page names it. Each is read by hand from a filing, a regulator’s page, or the company’s own, never press coverage, and kept only while power:verify still finds its quote. The sites, their power, and their users are Epoch’s, in recipe_observations.',
    POWER_SITE_TIE_COLUMNS,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of site, role, company_name, source_url, and quote.',
      },
      site: {
        type: 'text',
        meaning:
          'Epoch’s name for the site, exactly: the key of its epoch-data-centers rows in recipe_observations.',
      },
      role: {
        type: 'text',
        meaning:
          'utility, generation (a power plant or developer), equipment (turbines, fuel cells), host (the site’s owner or operator), or grid (the grid operator the site draws from).',
      },
      company_name: {
        type: 'text',
        meaning: 'The company as the page names it, or the grid operator on a grid row.',
      },
      parent: {
        type: 'text',
        nullable: true,
        meaning: 'The listed parent when the company is a subsidiary. Null otherwise.',
      },
      ticker: {
        type: 'text',
        nullable: true,
        meaning:
          'The ticker of the company or its listed parent. Null when neither is listed, and on a grid row.',
      },
      unlisted: {
        type: 'text',
        nullable: true,
        meaning:
          'Why there is no ticker: municipal, federal, or private. Null when there is one, and on a grid row.',
      },
      mw: {
        type: 'number',
        unit: 'megawatts',
        nullable: true,
        meaning:
          'A megawatt figure the page itself ties to this site and company. Null where the page gives none.',
      },
      mw_meaning: {
        type: 'text',
        nullable: true,
        meaning: 'What mw measures, in the page’s terms. Null with no mw.',
      },
      source_title: {
        type: 'text',
        nullable: true,
        meaning: 'The page’s title. Null on a grid row.',
      },
      publisher: {
        type: 'text',
        nullable: true,
        meaning: 'Who published the page. Null on a grid row.',
      },
      published: {
        type: 'date',
        nullable: true,
        meaning: 'The day the page was published. Null where it gives none, and on a grid row.',
      },
      quote: {
        type: 'text',
        meaning: 'The passage the row rests on, byte-identical to the page.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The page the passage is on.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When power:verify last fetched the page and found the quote, in UTC.',
      },
    },
    POWER_SITE_TIES,
    HAND_READ('power:verify'),
  ),
} satisfies Record<string, ExportTable>
