// The company registries kept in code (which securities carry each lab and filer,
// and every company's identifiers) and the passages read from the suppliers'
// filings. Part of EXPORT_TABLES (server/registries/export-tables.ts), which
// fixes the order.

import { ENTITY_SECURITIES, ENTITY_SECURITY_COLUMNS } from '../utils/terminal-entities'
import { ENTITY_IDENTIFIERS, ENTITY_IDENTIFIER_COLUMNS } from '../utils/terminal-identifiers'
import * as tables from '#server/db/schema'
import {
  CIK,
  plainTable,
  staticTable,
  type ExportTable,
  type Row,
} from '#layers/core/server/utils/terminal-export-views'

/** A plainTable whose JSON-text columns are served parsed, as the in-code table served them. */
function parsedJson(table: ExportTable, columns: readonly string[]): ExportTable {
  const parse = (row: Row): Row => {
    const out = { ...row }
    for (const c of columns) if (typeof out[c] === 'string') out[c] = JSON.parse(out[c] as string)
    return out
  }
  return {
    ...table,
    async page(db, after, limit, where) {
      return (await table.page(db, after, limit, where)).map(parse)
    },
  }
}

export const COMPANY_REFERENCE_TABLES = {
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
  supplier_passages: parsedJson(
    plainTable(
      'supplier_passages',
      'The chip, hardware, and compute-rental companies whose own SEC documents tie them to a lab or a cloud: one row per passage, quoted, with the figures it states. The first rows were read by hand; each company’s new filings are read by a model and kept only where the quote and every figure are in the filing word for word (basis). A share is the filing’s own figure for one customer in the period it names, and fiscal years differ. Where a filing gives a customer’s share and no name, the row keeps the filing’s label (“Customer A”) and names no one. A row ends when the company’s next filing of the same form no longer has its quote, and stays in the table with ended_at set.',
      tables.supplierPassages,
      {
        id: {
          type: 'text',
          key: true,
          meaning:
            'SHA-256 (hex) of ticker, relation, counterparty, source_url, and quote, as first read. A row later restamped to a newer filing keeps its id.',
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
        basis: {
          type: 'text',
          meaning:
            'hand (read by a person) or judge (read by a model from the stored filing, and checked by the Worker: the quote and every figure are in the filing verbatim).',
        },
        accession_no: {
          type: 'text',
          nullable: true,
          meaning: 'The EDGAR accession number of the document at source_url.',
        },
        first_seen_at: {
          type: 'timestamp',
          meaning:
            'When the row entered the table, in UTC: the hand read’s check, or the judge’s reading.',
        },
        ended_at: {
          type: 'timestamp',
          nullable: true,
          meaning:
            'When the company’s next filing of the same form was read and no longer had the quote, in UTC. Null while the passage stands.',
        },
        ended_by: {
          type: 'text',
          nullable: true,
          meaning: 'The accession number of that filing. Null while the passage stands.',
        },
        source_url: {
          type: 'text',
          provenance: true,
          meaning: 'The SEC document on EDGAR the passage is in.',
        },
        fetched_at: {
          type: 'timestamp',
          provenance: true,
          meaning:
            'When the document at source_url was last fetched and the quote found in it, in UTC.',
        },
      },
      [tables.supplierPassages.id],
      'rows are restamped to newer filings and ended in place, so the table’s past isn’t kept.',
    ),
    ['figures'],
  ),
} satisfies Record<string, ExportTable>
