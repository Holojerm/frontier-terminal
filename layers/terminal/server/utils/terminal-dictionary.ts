// The data dictionary: every exported column's type, meaning, unit, nullability
// and role, for /data, /export/dictionary.json and /export/dictionary.csv.
//
// Column order, descriptions and the as_of mode come from EXPORT_TABLES; only
// what the export code cannot say about itself is written here. Every meaning
// was read off the code that writes the column (the zod contracts in
// pipeline/contracts, the parsers, refresh.ts, the theses writers), not
// inferred from its name. layers/terminal/test/terminal-dictionary.test.ts fails
// when an exported column has no entry here, or an entry names a column the
// export no longer has.

import type {
  DataDictionary,
  DictionaryColumn,
  DictionaryTable,
  DictionaryType,
} from '../../shared/utils/terminal-types'
import {
  DATA_LICENSE,
  HISTORY_LICENSE,
  HISTORY_PARAM,
  LICENSE_SPLIT_EFFECTIVE,
  LICENSE_WINDOW_DAYS,
} from '#shared/utils/license'
import { ALERTS_METHOD } from './terminal-asof'
import {
  EXPORT_TABLES,
  LICENSE_COLUMN,
  csvLine,
  historyRule,
  type ExportTable,
} from './terminal-export'

interface ColumnDoc {
  type: DictionaryType
  meaning: string
  unit?: string
  nullable?: true
  /** Part of the row's unique key. */
  key?: true
  /** Where and when the row was read. */
  provenance?: true
}

interface TableDoc {
  columns: Readonly<Record<string, ColumnDoc>>
  /** How a `cut` table is cut at as_of. Rebuilt and refused tables say so from the export. */
  asOf?: string
}

/** Served at /export/dictionary.json and .csv; no export table may take the name. */
export const DICTIONARY_NAME = 'dictionary'

/** The column a current-row table gains when rebuilt as of T (terminal-export.ts › entityView). */
export const AS_OF_VERIFIED = 'as_of_verified'

export const DATA_TYPES: Readonly<Record<DictionaryType, string>> = {
  text: 'A string.',
  integer: 'A whole number.',
  number: 'A decimal number, as the source states it. We never round it.',
  timestamp:
    'An ISO-8601 timestamp with its zone (Z or ±hh:mm). Stamps we write are UTC. Stamps read from a vendor keep the vendor’s offset.',
  date: 'A calendar date, YYYY-MM-DD.',
  json: 'Structured data. Nested in the JSON export and JSON text in a CSV cell, except where the meaning says the column is JSON text in both.',
  boolean: 'true or false, as the words true and false in a CSV cell.',
}

export const PROVENANCE_NOTE =
  'Every row ends with source_url, the URL it was read from, and fetched_at, when that fetch ran. source_runs has started_at instead, since a failed run fetched nothing. entity_securities has checked_on, since its rows are hand-checked. In a CSV an empty cell is null.'

export const LICENSE_NOTE =
  `Rows dated in the last ${LICENSE_WINDOW_DAYS} days are ${DATA_LICENSE.short}. ` +
  `A table that grows over time downloads only those rows by default. Add ?${HISTORY_PARAM}=full for every row. ` +
  `That download adds a ${LICENSE_COLUMN} column before source_url: ${HISTORY_LICENSE.id} for a row dated before the window that we first published on or after ${LICENSE_SPLIT_EFFECTIVE}, ${DATA_LICENSE.id} for the rest. ` +
  'Tables of current rows and lookups download whole. Rebuilt at an as_of before the window, they get the same column. ' +
  'Upstream data keeps its own license.'

const REBUILT_NOTE =
  'Rebuilt from the current rows and the change log. For each key we take the content the first change after as_of replaced, else the current row if it was written by then. The view gains an as_of_verified column. False marks a key whose state the log does not confirm.'

// ---- shared columns ---------------------------------------------------------

const PROVIDER: ColumnDoc = {
  type: 'text',
  meaning: 'The lab the row belongs to: openai, anthropic, google, xai, meta, mistral, or other.',
}

const SOURCE_NAME: ColumnDoc = {
  type: 'text',
  meaning:
    'The source the row was read from, as sources.yaml names it. The Coverage panel lists each with its URL.',
}

/** In an entity view the source is part of the key: two pages can list the same entity. */
const SOURCE_ID: ColumnDoc = { ...SOURCE_NAME, key: true }

const CIK: ColumnDoc = { type: 'text', meaning: 'The filer’s SEC CIK, ten digits, zero-padded.' }

const entityKey = (shape: string, more = ''): ColumnDoc => ({
  type: 'text',
  key: true,
  meaning: `The row’s key across polls, ${shape}. With source_id it identifies the row.${more}`,
})

/** The trailing columns every entity view shares (terminal-export.ts › entityView). */
const ENTITY_TAIL = {
  content_hash: {
    type: 'text',
    meaning:
      'SHA-256 (hex) of the row’s content. It changes when the content does, and each change is a row in changes.',
  },
  snapshot_id: {
    type: 'text',
    meaning: 'The snapshots.id of the fetch whose parse produced the row’s current content.',
  },
  first_seen_at: {
    type: 'timestamp',
    meaning: 'When a fetch first produced the row, in UTC. It never changes.',
  },
  [AS_OF_VERIFIED]: {
    type: 'boolean',
    meaning:
      'With ?as_of= only. False where the newest change at or before as_of disagrees with the rebuilt row, so the row may not be what the store held then.',
  },
  source_url: {
    type: 'text',
    provenance: true,
    meaning: 'The URL the row’s current content was read from.',
  },
  fetched_at: {
    type: 'timestamp',
    provenance: true,
    meaning:
      'When the fetch that produced the row’s current content ran, in UTC. A later fetch that finds the same content doesn’t move it. source_runs has every check.',
  },
} satisfies Record<string, ColumnDoc>

const entityView = (shape: string, fields: Record<string, ColumnDoc>, more = ''): TableDoc => ({
  columns: {
    entity_key: entityKey(shape, more),
    source_id: SOURCE_ID,
    provider: PROVIDER,
    ...fields,
    ...ENTITY_TAIL,
  },
})

/** The leading and trailing columns of every registration-statement view (partsView, FILING_FIELDS). */
const prospectusView = (shape: string, fields: Record<string, ColumnDoc>): TableDoc => ({
  columns: {
    entity_key: {
      type: 'text',
      key: true,
      meaning: `The filing’s entity, ${shape}. With source_id and part it identifies the row.`,
    },
    source_id: SOURCE_ID,
    provider: { ...PROVIDER, meaning: 'The lab that filed the registration statement.' },
    part: {
      type: 'integer',
      key: true,
      meaning: 'The row’s position within its entity, from 0, in the order the filing prints it.',
    },
    cik: { ...CIK, meaning: 'The registrant’s SEC CIK, ten digits, zero-padded.' },
    entity_name: { type: 'text', meaning: 'The registrant’s name as the filing prints it.' },
    accession_no: { type: 'text', meaning: 'The registration filing’s EDGAR accession number.' },
    form: { type: 'text', meaning: 'The filing’s form type: S-1 or S-1/A.' },
    filed: { type: 'date', meaning: 'The day the filing was filed with the SEC.' },
    ...fields,
    first_seen_at: ENTITY_TAIL.first_seen_at,
    source_url: {
      type: 'text',
      provenance: true,
      meaning: 'The registration document on EDGAR the row was read from.',
    },
    fetched_at: ENTITY_TAIL.fetched_at,
  },
})

const usd = 'USD'
const perMtok = 'USD per million tokens'

const price = (what: string): ColumnDoc => ({
  type: 'number',
  unit: perMtok,
  nullable: true,
  meaning: `List price of ${what}. Null where the page prints none.`,
})

/** A string the source prints, kept as printed; `nullWhen` makes it nullable and says when. */
const verbatim = (what: string, nullWhen?: string): ColumnDoc => ({
  type: 'text',
  meaning: `${what}, verbatim${nullWhen ? `. Null ${nullWhen}` : ''}.`,
  ...(nullWhen ? { nullable: true as const } : {}),
})

const changeHash = (side: 'before' | 'after', nullWhen: string): ColumnDoc => ({
  type: 'text',
  nullable: true,
  meaning: `The row’s content_hash ${side} the change. Null when ${nullWhen}.`,
})

const changeJson = (side: 'before' | 'after', nullWhen: string): ColumnDoc => ({
  type: 'json',
  nullable: true,
  meaning: `JSON text (a string in the JSON export too): the row’s content ${side} the change. Null when ${nullWhen}.`,
})

// ---- per table ----------------------------------------------------------------

export const COLUMN_DOCS: Readonly<Record<string, TableDoc>> = {
  snapshots: {
    asOf: 'Rows with fetched_at at or before as_of.',
    columns: {
      id: { type: 'text', key: true, meaning: 'The fetch: <source_id>:<fetched_at>.' },
      source_id: SOURCE_NAME,
      content_hash: { type: 'text', meaning: 'SHA-256 (hex) of the fetched body.' },
      raw_key: {
        type: 'text',
        meaning:
          'Key of the raw body in this site’s object store (R2). A fetch that found the same content points at the existing object.',
      },
      http_status: {
        type: 'integer',
        nullable: true,
        meaning: 'The response’s HTTP status. Null where none was recorded.',
      },
      bytes: {
        type: 'integer',
        unit: 'bytes',
        nullable: true,
        meaning: 'Size of the fetched body. Null where none was recorded.',
      },
      source_url: { type: 'text', provenance: true, meaning: 'The URL fetched.' },
      fetched_at: { type: 'timestamp', provenance: true, meaning: 'When the fetch ran, in UTC.' },
    },
  },

  prices_latest: entityView(
    'model:<provider>:<model_slug>, with :<tier> when the SKU has one',
    {
      model_slug: {
        type: 'text',
        meaning: 'The model’s identifier as the vendor’s page prints it.',
      },
      tier: {
        type: 'text',
        nullable: true,
        meaning:
          'The price tier, where a model has several (Google’s standard, batch, flex, and priority, or xAI’s long_context). Null for a single-tier SKU.',
      },
      context_window: {
        type: 'text',
        nullable: true,
        meaning:
          'The context window as printed (“500k”, “1M”), not converted to tokens. Null where the page states none.',
      },
      input_per_mtok: price('input tokens'),
      cached_input_per_mtok: price('cached input tokens (a cache hit)'),
      output_per_mtok: price('output tokens'),
      currency: { type: 'text', meaning: 'Always USD.' },
      effective_from: {
        type: 'date',
        nullable: true,
        meaning:
          'The day a scheduled price takes effect, where the page announces one. Null for the price in force.',
      },
      effective_until: {
        type: 'date',
        nullable: true,
        meaning:
          'The day the page says the price in force is replaced. Null when no change is scheduled.',
      },
      notes: verbatim(
        'Qualifiers the page prints beside the row (cache-write prices, promotions, deprecations)',
        'where it prints none',
      ),
    },
    ' A models page and a pricing page can both list a SKU, so one entity_key can have two rows.',
  ),

  jobs_open: entityView('job:<provider>:<job_id>', {
    job_id: {
      type: 'text',
      meaning:
        'The board’s own job id: an Ashby UUID, a Greenhouse number, or a Google careers id.',
    },
    title: verbatim('The role title'),
    department: {
      type: 'text',
      nullable: true,
      meaning:
        'The department as the board names it (on Google’s feed, its categories joined by commas). Null where the board gives none.',
    },
    team: {
      type: 'text',
      nullable: true,
      meaning: 'The team within the department. Ashby boards only. Null elsewhere.',
    },
    location: verbatim(
      'The location text, several locations in one string',
      'where the board gives none',
    ),
    employment_type: {
      type: 'text',
      nullable: true,
      meaning:
        'The employment type as the board labels it (FullTime, …). Null where the board does not carry one, as Greenhouse does not.',
    },
    published_at: {
      type: 'timestamp',
      nullable: true,
      meaning: 'When the board says the role was first published, with the board’s own offset.',
    },
    updated_at: {
      type: 'timestamp',
      nullable: true,
      meaning:
        'When the board says the listing last changed, with its own offset. Null where the board gives none (Google’s feed).',
    },
    company_name: {
      type: 'text',
      nullable: true,
      meaning:
        'The employer the board prints, verbatim. Every xAI row says SpaceXAI: that board lists SpaceX and xAI roles together.',
    },
  }),

  incidents: entityView('incident:<provider>:<incident_id>', {
    incident_id: { type: 'text', meaning: 'The status page’s own incident id.' },
    title: verbatim('The incident title'),
    impact: {
      type: 'text',
      nullable: true,
      meaning:
        'The vendor’s impact or severity word, verbatim and not mapped across vendors. Statuspage uses none, minor, major, and critical. Google Cloud uses low, medium, and high. Null where the feed publishes none, as Anthropic’s Atom feed does.',
    },
    status: {
      type: 'text',
      meaning:
        'The vendor’s status word, verbatim. Statuspage uses investigating, identified, monitoring, resolved, and postmortem. Google Cloud gives the latest update’s status (AVAILABLE once resolved).',
    },
    started_at: { type: 'timestamp', meaning: 'When the incident started, as the feed states it.' },
    resolved_at: {
      type: 'timestamp',
      nullable: true,
      meaning: 'When the incident was resolved, as the feed states it. Null while open.',
    },
    components: {
      type: 'json',
      meaning:
        'The affected components (Statuspage) or products (Google Cloud): an array of names, sorted, possibly empty.',
    },
    incident_url: { type: 'text', meaning: 'The incident’s own page on the status site.' },
  }),

  disclosures: entityView('disclosure:<provider>:<kind>:<entry_id>', {
    kind: { type: 'text', meaning: 'report or notice.' },
    entry_id: {
      type: 'text',
      meaning: 'The entry’s id on the index: a report’s slug, or a notice’s id without “notice-”.',
    },
    title: verbatim('The entry’s title'),
    summary: verbatim('The index’s one-sentence summary'),
    model: verbatim('The model the report concerns', 'on a notice'),
    observed_during: verbatim('The context the behavior was observed in', 'on a notice'),
    listed_on: {
      type: 'date',
      meaning:
        'The date the index prints beside the entry: a report’s last update, a notice’s posting date. It moves when a report is revised.',
    },
    entry_url: { type: 'text', meaning: 'The entry’s own page.' },
  }),

  disclosure_timelines: entityView('disclosure_timeline:<provider>:<entry_id>', {
    entry_id: { type: 'text', meaning: 'The report’s slug. It joins disclosures.entry_id.' },
    title: verbatim('The report page’s own title'),
    lines: {
      type: 'json',
      meaning:
        'Every “Label: value” line of the page’s metadata, verbatim and in page order, minus “Report updated”: an array of {label, value} objects.',
    },
    discovered_on: {
      type: 'date',
      nullable: true,
      meaning:
        'The discovery date, from the line under any label the vendor uses for it, when that value is a single date. Null otherwise.',
    },
    disclosed_on: {
      type: 'date',
      nullable: true,
      meaning: 'A printed disclosure date, when the page has one that is a single date.',
    },
  }),

  filers: entityView('filer:<provider>, one per lab', {
    cik: CIK,
    name: verbatim('EDGAR’s display name for the filer'),
    resolved_form: {
      type: 'text',
      meaning: 'The form of the filing the CIK was read from (S-1, S-1/A).',
    },
    resolved_accession: { type: 'text', meaning: 'That filing’s EDGAR accession number.' },
    resolved_file_date: { type: 'date', meaning: 'The day that filing was filed.' },
  }),

  revenue_facts: entityView(
    'revenue:<cik>:<tag>:<accession_no>:<start>:<end>',
    {
      cik: CIK,
      entity_name: { type: 'text', meaning: 'The filer’s name as EDGAR or the filing gives it.' },
      taxonomy: {
        type: 'text',
        meaning:
          'us-gaap for an XBRL fact (the SEC’s tagged financial data). prospectus for a figure read off the statement of operations in a registration filing that tags no financials.',
      },
      tag: {
        type: 'text',
        meaning:
          'The XBRL revenue tag, or for prospectus the statement’s row label verbatim. Filers switch tags between years, so a series can span several.',
      },
      unit: { type: 'text', meaning: 'Always USD.' },
      start: { type: 'date', meaning: 'First day of the period the value covers.' },
      end: { type: 'date', meaning: 'Last day of the period the value covers.' },
      val: {
        type: 'number',
        unit: usd,
        meaning: 'The filer’s own value for the period, in US dollars, never scaled or rounded.',
      },
      accession_no: {
        type: 'text',
        meaning:
          'The filing that reported the value. A restatement is a new row under its own accession.',
      },
      fy: {
        type: 'integer',
        nullable: true,
        meaning: 'The fiscal year as the filer tagged it.',
      },
      fp: {
        type: 'text',
        nullable: true,
        meaning: 'The fiscal period as the filer tagged it: FY or Q1 to Q4.',
      },
      form: { type: 'text', meaning: 'The reporting filing’s form type (10-K, 10-Q, S-1, …).' },
      filed: { type: 'date', meaning: 'The day the reporting filing was filed.' },
      frame: {
        type: 'text',
        nullable: true,
        meaning:
          'SEC’s calendar frame (CY2026Q2) when this fact is the canonical one for it. Null otherwise.',
      },
      whitelist_cik: {
        type: 'text',
        nullable: true,
        meaning:
          'The CIK again when the filer is on the sources.yaml whitelist of filers whose filings alert. Null otherwise.',
      },
    },
    ' A segment fact’s key ends with its segment member (:goog:GoogleCloudMember). There’s no segment column, so the key is what tells a segment value from the consolidated one.',
  ),

  prospectus_statements: prospectusView('statement:<cik>:<accession_no>:<start>:<end>', {
    start: { type: 'date', meaning: 'First day of the period.' },
    end: { type: 'date', meaning: 'Last day of the period.' },
    unaudited: {
      type: 'boolean',
      meaning: 'True for an interim period, which registration statements print unaudited.',
    },
    units: {
      type: 'text',
      meaning:
        'The statement’s units line, verbatim (“in millions, except per share data”). val is already scaled out of it.',
    },
    line_key: {
      type: 'text',
      meaning:
        'A canonical key where the label is a known one (revenue, total_operating_expenses, operating_income, net_income, …), else the label slugged.',
    },
    label: verbatim('The line’s label as the statement prints it'),
    val: {
      type: 'number',
      unit: 'USD, USD per share, or shares, as unit says',
      nullable: true,
      meaning:
        'The line’s value in whole units, scaled out of the printed millions or thousands. Negative where the statement prints parentheses, null where it prints a dash.',
    },
    unit: { type: 'text', meaning: 'USD, USD/share, or shares.' },
  }),

  prospectus_commitments: prospectusView(
    'commitment:<accession_no>:<schedule>:<as_of, or undated>',
    {
      schedule: {
        type: 'text',
        meaning:
          'contractual_obligations (MD&A’s table), purchase_commitments (the commitments note’s audited schedule), purchase_commitments_interim (the note’s one-sentence interim total), or obligations_aggregate (MD&A’s one-sentence total).',
      },
      as_of: {
        type: 'date',
        nullable: true,
        meaning: 'The date the schedule is stated as of. Null when its sentence names none.',
      },
      audited: { type: 'boolean', meaning: 'True for a schedule in the audited notes.' },
      approximate: {
        type: 'boolean',
        meaning: 'True when the filing itself calls the figure approximate.',
      },
      line: verbatim('The obligation’s label'),
      bucket: {
        type: 'text',
        meaning:
          'When the amount falls due, as the filing labels it (“2026”, “Thereafter”), or Total for the line’s total.',
      },
      val: {
        type: 'number',
        unit: usd,
        meaning: 'The amount in US dollars, scaled out of the printed millions or thousands.',
      },
      statement: verbatim(
        'For a one-figure schedule, the sentence it was read from',
        'for a table',
      ),
    },
  ),

  prospectus_concentration: prospectusView('concentration:<accession_no>:<basis>', {
    basis: { type: 'text', meaning: 'revenue or accounts_receivable.' },
    customer: { type: 'text', meaning: 'The customer as the filing names it (“Customer A”).' },
    start: {
      type: 'date',
      nullable: true,
      meaning: 'First day of the revenue period. Null for a receivables balance.',
    },
    end: { type: 'date', meaning: 'Last day of the revenue period, or the balance date.' },
    unaudited: { type: 'boolean', meaning: 'True for an unaudited interim column.' },
    pct: {
      type: 'number',
      unit: 'percent, 0 to 100',
      nullable: true,
      meaning:
        'The customer’s share of revenue or of receivables. Null is the filing’s “*”: under 10%. It isn’t zero.',
    },
  }),

  prospectus_shares: prospectusView('shares:<accession_no>', {
    measure: {
      type: 'text',
      meaning:
        'the_offering for a row of “The Offering” summary. before_offering for a pre-offering count it is based on.',
    },
    as_of: {
      type: 'date',
      nullable: true,
      meaning: 'The date a before_offering count is stated as of. Null on the_offering rows.',
    },
    label: verbatim('The row’s label'),
    shares: {
      type: 'integer',
      unit: 'shares',
      nullable: true,
      meaning: 'The count in whole shares. Null while the filing leaves it blank.',
    },
    with_option: {
      type: 'integer',
      unit: 'shares',
      nullable: true,
      meaning:
        'The count if the underwriters exercise their option in full, where the row states one. Null on before_offering rows.',
    },
  }),

  prospectus_risk_factors: prospectusView('risk_factors:<accession_no>', {
    section: verbatim('The “Risks Related to …” subsection the heading sits under'),
    heading: verbatim('The risk-factor heading'),
    change: {
      type: 'text',
      nullable: true,
      meaning:
        'Against the same filer’s previous filing: unchanged, added, reworded, or removed (a heading only the previous filing printed). Null on a filer’s first filing.',
    },
    previous: verbatim('For a reworded heading, the previous filing’s words', 'otherwise'),
  }),

  changes: {
    asOf: 'Rows with detected_at at or before as_of.',
    columns: {
      id: {
        type: 'text',
        key: true,
        meaning:
          'SHA-256 (hex) of the entity key and the two content hashes, so the same change is never logged twice. A filed_fact change hashes its series, period, and accession instead.',
      },
      entity_key: {
        type: 'text',
        meaning: 'The changed row’s entity_key, as the views above use it.',
      },
      entity_type: {
        type: 'text',
        meaning:
          'The kind of row: model, job, incident, disclosure, disclosure_timeline, filer, revenue, filing, document, offering, statement, commitment, concentration, shares, risk_factors, recommendation, or filed_fact (a hyperscaler series point a new filing moved, cited by its alert). OpenRouter ranking rows are left out.',
      },
      provider: PROVIDER,
      change_type: { type: 'text', meaning: 'added, removed, or modified.' },
      before_hash: changeHash('before', 'added'),
      after_hash: changeHash('after', 'removed'),
      before_json: changeJson('before', 'added'),
      after_json: changeJson('after', 'removed'),
      detected_at: {
        type: 'timestamp',
        meaning: 'When the fetch that observed the change ran, in UTC. Same instant as fetched_at.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The URL whose fetch observed the change.',
      },
      fetched_at: { type: 'timestamp', provenance: true, meaning: 'When that fetch ran, in UTC.' },
    },
  },

  alerts: {
    asOf: ALERTS_METHOD,
    columns: {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of what the alert is about. Its page is /alerts/<id>.',
      },
      severity: { type: 'text', meaning: 'info, notable, or critical.' },
      headline: { type: 'text', meaning: 'The alert in one line.' },
      explanation: {
        type: 'text',
        meaning: 'Why it matters. It cites only fields in the changes it cites.',
      },
      change_ids: {
        type: 'json',
        meaning:
          'JSON text (a string in the JSON export too): an array of the changes.id it cites.',
      },
      rule: {
        type: 'text',
        meaning:
          'What wrote it: agent-judge (the judge routine), or a deterministic rule: s1-floor, periodic-floor, cik-resolved, model-floor, prospectus-floor, hiring-rollup, filed-fact-floor.',
      },
      created_at: {
        type: 'timestamp',
        meaning: 'When the alert counts from: the detection of the newest change it cites, in UTC.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The URL of the change the alert is stamped from.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that change’s fetch ran, in UTC.',
      },
    },
  },

  claim_readings: {
    columns: {
      thesis_id: {
        type: 'text',
        meaning: 'The thesis the claim belongs to. Its page is /theses/<thesis_id>.',
      },
      claim_id: { type: 'text', key: true, meaning: 'The claim, unique across theses.' },
      date: { type: 'date', key: true, meaning: 'The data date the reading is for.' },
      value: {
        type: 'number',
        unit: 'the claim’s own: a 0..1 share, a ratio, a growth rate, a count, USD, or USD per million tokens',
        meaning:
          'The measured value the claim’s kill condition is checked against. The thesis page gives the claim’s unit.',
      },
      detail: {
        type: 'json',
        meaning:
          'JSON text (a string in the JSON export too): the inputs behind the value, shaped by the claim’s signal.',
      },
      computed_at: {
        type: 'timestamp',
        meaning: 'When the reading was last computed with a different value or detail, in UTC.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The source of the reading’s newest input.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that input was fetched, in UTC.',
      },
    },
  },

  claim_verdicts: {
    asOf: 'Verdicts with detected_at and judged_at both at or before as_of: a verdict is held back until it was judged.',
    columns: {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of claim_id and subject: one verdict per claim and subject.',
      },
      thesis_id: { type: 'text', meaning: 'The thesis the claim belongs to.' },
      claim_id: { type: 'text', meaning: 'The judged claim.' },
      subject: {
        type: 'text',
        meaning:
          'What the verdict rates: the changes.id of a price cut, the entity_key of an incident or disclosure (so an incident updated twice is rated once), or the recipe_observations.id of a recipe item.',
      },
      change_id: {
        type: 'text',
        meaning: 'The changes.id, or recipe_observations.id, of the record the judge was shown.',
      },
      provider: {
        type: 'text',
        meaning: 'The company the event concerns: a lab id, or a company id such as cloudflare.',
      },
      verdict: {
        type: 'text',
        meaning:
          'The judge’s verdict, from the claim’s own set: competitive or generational for a price cut, material or not-material for an incident or disclosure. A recipe claim lists its own.',
      },
      rationale: {
        type: 'text',
        meaning:
          'The judge’s reason, at most 600 characters, grounded against the record and the facts.',
      },
      facts: {
        type: 'json',
        meaning:
          'JSON text (a string in the JSON export too): what the Worker computed about the event, such as a cut’s size or an outage’s hours.',
      },
      detected_at: {
        type: 'text',
        meaning:
          'When the rated record was detected: the change’s detected_at (an ISO-8601 timestamp), or for a recipe item the observation’s date (YYYY-MM-DD).',
      },
      judged_at: {
        type: 'timestamp',
        meaning: 'When the judge run that wrote the verdict ran, in UTC.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The URL the rated record was read from.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that record was fetched, in UTC.',
      },
    },
  },

  track_record_candidates: {
    asOf: 'Rows with found_at at or before as_of.',
    columns: {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of alert_id, kind and url: one row per alert, kind and URL.',
      },
      alert_id: { type: 'text', meaning: 'The alerts.id the candidate was found for.' },
      kind: {
        type: 'text',
        meaning:
          'press, an article GDELT indexed, or newsroom, a post on the lab’s own newsroom feed.',
      },
      title: {
        type: 'text',
        meaning:
          'The headline as GDELT or the feed gives it. GDELT spaces out punctuation (“GPT - 6 . 1”), and we keep that as read.',
      },
      snippet: {
        type: 'text',
        nullable: true,
        meaning:
          'The first 400 characters of a newsroom post’s description. Null for press, since GDELT returns no article text.',
      },
      outlet: {
        type: 'text',
        meaning: 'The site’s domain, as GDELT names it or from the post’s link.',
      },
      url: { type: 'text', meaning: 'The article or post itself.' },
      published_at: {
        type: 'timestamp',
        meaning:
          'For press, when GDELT’s crawler first saw the article (not when the outlet published it). For a newsroom post, its own publication time. UTC.',
      },
      search_id: {
        type: 'text',
        meaning:
          'The search that found it. Searches aren’t exported. The page shows each one’s outcome.',
      },
      found_at: { type: 'timestamp', meaning: 'When the search that found it ran, in UTC.' },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The GDELT query URL, or the newsroom feed the post was read from.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that query or feed was fetched, in UTC.',
      },
    },
  },

  track_record_verdicts: {
    asOf: 'Rows with judged_at at or before as_of.',
    columns: {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of candidate_id: one verdict per candidate.',
      },
      candidate_id: { type: 'text', meaning: 'The track_record_candidates.id rated.' },
      alert_id: { type: 'text', meaning: 'The alert the candidate was found for.' },
      same_event: {
        type: 'boolean',
        meaning:
          'True when the judge read the headline (and snippet) as reporting the alert’s own event. A vague headline is rated false.',
      },
      rationale: {
        type: 'text',
        meaning:
          'The judge’s reason, at most 400 characters, grounded against the headline and the alert’s change rows.',
      },
      judged_at: {
        type: 'timestamp',
        meaning: 'When the judge run that wrote the verdict ran, in UTC.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The candidate’s own URL (the article or post rated).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When the candidate was fetched, in UTC.',
      },
    },
  },

  recipe_observations: {
    columns: {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of recipe_id, key and date: one row per recipe, key and date.',
      },
      recipe_id: {
        type: 'text',
        meaning: 'The recipe that read the value (layers/terminal/server/theses/recipes/).',
      },
      company: {
        type: 'text',
        meaning:
          'The company the recipe reads about: a lab id or a company id (cloudflare, coreweave, …).',
      },
      key: {
        type: 'text',
        meaning:
          'What the number is of: a revenue tag, a department, a package, a GPU offer, an entry.',
      },
      date: {
        type: 'date',
        meaning:
          'What the number is for: a quarter end, a day, an entry’s date, or the run’s UTC date for a source that reports a current state.',
      },
      value: {
        type: 'number',
        unit: 'the recipe’s own (USD, USD per GPU-hour, a count, megawatts, …)',
        nullable: true,
        meaning: 'The number read. Null where the entry carries none.',
      },
      payload: {
        type: 'json',
        meaning:
          'JSON text (a string in the JSON export too): the fields kept beside the value, and all a judged rationale may cite.',
      },
      raw_key: {
        type: 'text',
        meaning:
          'Key of the raw response the value was read from in this site’s object store (R2).',
      },
      first_seen_at: {
        type: 'timestamp',
        meaning: 'When this recipe, key and date was first read, in UTC.',
      },
      source_url: { type: 'text', provenance: true, meaning: 'The URL the recipe fetched.' },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning:
          'When the current value was read, in UTC. A re-read that finds the same value does not move it.',
      },
    },
  },

  filed_facts: {
    asOf: 'Rows whose filing date is before the UTC day of as_of. A fact counts from the day after its filing, whenever we read it, so this table answers as_of back to 2019.',
    columns: {
      id: {
        type: 'text',
        key: true,
        meaning: 'SHA-256 (hex) of ticker, concept, dims, start, end, and accession_no.',
      },
      ticker: { type: 'text', meaning: 'The filer: MSFT, GOOGL, AMZN, META, or ORCL.' },
      cik: CIK,
      concept: {
        type: 'text',
        meaning:
          'The XBRL concept with its prefix, e.g. us-gaap:PaymentsToAcquirePropertyPlantAndEquipment.',
      },
      dims: {
        type: 'text',
        meaning:
          'The context’s dimensions as axis=member pairs, sorted and joined with “;”. A typed member’s value stands in for the member. Empty for a fact with no dimension.',
      },
      start: {
        type: 'date',
        nullable: true,
        meaning: 'The period’s first day. Null for a balance, which is at end.',
      },
      end: { type: 'date', meaning: 'The period’s last day, or the balance date.' },
      value: {
        type: 'number',
        unit: 'the row’s unit column',
        meaning: 'The value as tagged, signed as the filer tagged it.',
      },
      unit: {
        type: 'text',
        meaning: 'USD, shares, pure (a ratio, 0.24 is 24%), or the measure as written.',
      },
      form: { type: 'text', meaning: 'The filing’s form: 10-Q, 10-K, or an amendment.' },
      filed: { type: 'date', meaning: 'The filing date EDGAR gives the accession.' },
      accession_no: { type: 'text', meaning: 'The filing’s EDGAR accession number.' },
      basis: {
        type: 'text',
        meaning:
          'companyfacts (EDGAR’s company facts, every fact with no dimension) or instance (the filing’s own XBRL instance, for a fact with dimensions).',
      },
      raw_key: {
        type: 'text',
        meaning: 'Key of the document the fact was read from in this site’s object store (R2).',
      },
      first_seen_at: { type: 'timestamp', meaning: 'When we first read the fact, in UTC.' },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The company facts document or the instance file the fact was read from.',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When that read ran, in UTC. A filed fact is never rewritten.',
      },
    },
  },

  exposure_quarters: {
    asOf: 'Built from the filed_facts rows filed before the UTC day of as_of, so it answers back to 2019.',
    columns: {
      series_id: {
        type: 'text',
        key: true,
        meaning:
          'The series, e.g. msft-capex or amzn-anthropic-equity-securities-without-readily-determinable-fair-value-upward-price-adjustment-annual-amount.',
      },
      ticker: { type: 'text', meaning: 'The filer: MSFT, GOOGL, AMZN, META, or ORCL.' },
      filer: {
        type: 'text',
        meaning: 'The filer’s name. Every value is the filer’s number, never a lab’s.',
      },
      group: { type: 'text', meaning: 'capex, rpo (backlog), openai, or anthropic.' },
      label: { type: 'text', meaning: 'What the series is, in plain words.' },
      concept: { type: 'text', meaning: 'The XBRL concept the series reads.' },
      dims: {
        type: 'text',
        meaning:
          'The dimensions of the facts the series reads, as in filed_facts. Several are joined with “ | ” when the filer tagged the line on different axes over time.',
      },
      kind: {
        type: 'text',
        meaning: 'flow (a value per quarter) or balance (a value at each period end).',
      },
      unit: { type: 'text', meaning: 'USD, shares, or pure (a ratio).' },
      start: {
        type: 'date',
        nullable: true,
        meaning: 'The quarter’s first day. Null for a balance.',
      },
      end: { type: 'date', key: true, meaning: 'The quarter’s last day, or the balance date.' },
      value: {
        type: 'number',
        unit: 'the row’s unit column',
        meaning: 'The value for the quarter or at the date.',
      },
      derived: {
        type: 'boolean',
        meaning:
          'True when the quarter is a year-to-date figure less the one a quarter shorter, because the filing tags only year to date.',
      },
      less_start: {
        type: 'date',
        nullable: true,
        meaning: 'For a derived quarter, the start of the figure taken away. Null otherwise.',
      },
      less_end: {
        type: 'date',
        nullable: true,
        meaning: 'For a derived quarter, the end of the figure taken away. Null otherwise.',
      },
      less_value: {
        type: 'number',
        unit: 'the row’s unit column',
        nullable: true,
        meaning: 'For a derived quarter, the figure taken away. Null otherwise.',
      },
      less_accession_no: {
        type: 'text',
        nullable: true,
        meaning:
          'For a derived quarter, the filing the figure taken away came from. Null otherwise.',
      },
      accession_no: {
        type: 'text',
        meaning: 'The filing the value is from: the newest that reported the period.',
      },
      form: { type: 'text', meaning: 'That filing’s form.' },
      filed: { type: 'date', meaning: 'That filing’s date.' },
      filing_url: { type: 'text', meaning: 'EDGAR’s index page for that filing.' },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The company facts document or the instance file the value was read from.',
      },
      fetched_at: { type: 'timestamp', provenance: true, meaning: 'When that read ran, in UTC.' },
    },
  },

  source_runs: {
    asOf: 'Rows with started_at at or before as_of.',
    columns: {
      id: { type: 'text', key: true, meaning: 'The run: <scope>:<source_id>:<started_at>.' },
      scope: {
        type: 'text',
        meaning:
          'Which poll ran it: edgar, survey, careers (the large careers feeds, on a six-hourly tick of their own), or tripwire (an off-cycle poll of the model catalogs).',
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
  },

  entity_securities: {
    columns: {
      entity: {
        type: 'text',
        key: true,
        meaning: 'The lab or filer id (anthropic, microsoft, …), as the rest of the site uses it.',
      },
      entity_name: { type: 'text', meaning: 'The lab’s or filer’s name.' },
      entity_kind: {
        type: 'text',
        meaning: 'lab (one of the six) or filer (a company whose filings the site reads).',
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
  },
}

// ---- assembly -----------------------------------------------------------------

/** The columns a table serves as of T: an entity view gains as_of_verified before its provenance. */
export function asOfColumns(table: ExportTable): string[] {
  if (table.pointInTime !== 'rebuilt') return [...table.columns]
  return [...table.columns.slice(0, -2), AS_OF_VERIFIED, ...table.columns.slice(-2)]
}

function asOfOf(table: ExportTable, doc: TableDoc): DictionaryTable['as_of'] {
  if (table.pointInTime === 'refused') {
    const reason = table.asOfRefusal ?? ''
    return {
      mode: 'refused',
      note: `as_of answers 400 for this table. ${reason.charAt(0).toUpperCase()}${reason.slice(1)}`,
    }
  }
  if (table.pointInTime === 'rebuilt') return { mode: 'rebuilt', note: REBUILT_NOTE }
  return { mode: 'cut', note: doc.asOf ?? '' }
}

function historyOf(table: ExportTable): DictionaryTable['history'] {
  const rule = historyRule(table.name)
  if (rule.kind === 'whole') {
    return {
      mode: 'whole',
      dated: [],
      full: null,
      note: `Downloads whole, since ${rule.why}`,
    }
  }
  return {
    mode: 'windowed',
    dated: [...rule.dated],
    full: `/export/${table.name}.csv?${HISTORY_PARAM}=full`,
    note: `Downloads the last ${LICENSE_WINDOW_DAYS} days by default, dated by ${rule.basis}. Add ?${HISTORY_PARAM}=full for every row.`,
  }
}

function dictionaryTable(table: ExportTable): DictionaryTable {
  const doc = COLUMN_DOCS[table.name]
  if (!doc) throw new Error(`no data dictionary entry for export ${table.name}`)
  const columns = asOfColumns(table).map((name): DictionaryColumn => {
    const c = doc.columns[name]
    if (!c) throw new Error(`no data dictionary entry for ${table.name}.${name}`)
    return {
      name,
      type: c.type,
      meaning: c.meaning,
      unit: c.unit ?? null,
      nullable: c.nullable === true,
      role: c.key ? 'key' : c.provenance ? 'provenance' : null,
      as_of_only: !table.columns.includes(name),
    }
  })
  return {
    name: table.name,
    description: table.description,
    csv: `/export/${table.name}.csv`,
    json: `/export/${table.name}.json`,
    key: columns.filter((c) => c.role === 'key').map((c) => c.name),
    as_of: asOfOf(table, doc),
    history: historyOf(table),
    columns,
  }
}

/** The whole dictionary, in export order. Pure: no database, so it can never be half-true. */
export function dataDictionary(): DataDictionary {
  return {
    types: { ...DATA_TYPES },
    provenance: PROVENANCE_NOTE,
    license: LICENSE_NOTE,
    tables: Object.values(EXPORT_TABLES).map(dictionaryTable),
  }
}

export const DICTIONARY_CSV_COLUMNS = [
  'table',
  'column',
  'type',
  'unit',
  'nullable',
  'role',
  'as_of_only',
  'meaning',
  'table_as_of',
  'table_history',
] as const

/** One CSV row per table and column, in export order. */
export function dictionaryCsv(dictionary: DataDictionary): string {
  return [
    csvLine(DICTIONARY_CSV_COLUMNS),
    ...dictionary.tables.flatMap((t) =>
      t.columns.map((c) =>
        csvLine([
          t.name,
          c.name,
          c.type,
          c.unit,
          c.nullable,
          c.role,
          c.as_of_only,
          c.meaning,
          t.as_of.mode,
          t.history.mode,
        ]),
      ),
    ),
  ].join('')
}
