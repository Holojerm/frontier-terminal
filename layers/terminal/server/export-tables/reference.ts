// The feed's own run log, and the entity registries kept in code. Part of EXPORT_TABLES (utils/terminal-export.ts), which fixes the order.

import { ENTITY_SECURITIES, ENTITY_SECURITY_COLUMNS } from '../utils/terminal-entities'
import { ENTITY_IDENTIFIERS, ENTITY_IDENTIFIER_COLUMNS } from '../utils/terminal-identifiers'
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
} satisfies Record<string, ExportTable>
