// What each source says now: the snapshot log and the entity views. Part of EXPORT_TABLES (utils/terminal-export.ts), which fixes the order.

import * as tables from '#server/db/schema'
import {
  SOURCE_NAME,
  entityKey,
  entityView,
  plainTable,
  price,
  verbatim,
  byColumn,
  loggedTotal,
  type ExportTable,
} from '../utils/terminal-export-views'

export const LIVE_TABLES = {
  snapshots: plainTable(
    'snapshots',
    'One row per fetch of every source, with its content hash, HTTP status, byte count, and the R2 key of the raw response.',
    tables.snapshots,
    {
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
    [tables.snapshots.fetched_at, tables.snapshots.id],
    byColumn(tables.snapshots.fetched_at),
    loggedTotal(tables.sourceStats.snapshot_count),
  ),
  prices_latest: entityView(
    'prices_latest',
    'The current price and catalog row per SKU and source, as each vendor page stated it at our last check.',
    'model',
    entityKey(
      'model:<provider>:<model_slug>, with :<tier> when the SKU has one',
      ' A models page and a pricing page can both list a SKU, so one entity_key can have two rows.',
    ),
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
  ),
  jobs_open: entityView(
    'jobs_open',
    'Every role currently listed on the job boards we track. A closed role leaves this table and shows up in changes.',
    'job',
    entityKey('job:<provider>:<job_id>'),
    {
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
    },
  ),
  incidents: entityView(
    'incidents',
    'Every status-page incident we’ve stored, with the vendor’s title, impact, and status verbatim, start and resolution, and components. Impact is null where the feed publishes none (Anthropic’s Atom feed doesn’t). We keep an incident after it drops out of its feed.',
    'incident',
    entityKey('incident:<provider>:<incident_id>'),
    {
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
      started_at: {
        type: 'timestamp',
        meaning: 'When the incident started, as the feed states it.',
      },
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
    },
  ),
  disclosures: entityView(
    'disclosures',
    'Every entry on a lab’s own misalignment-disclosure index (only OpenAI publishes one). Each row has the report or notice, title, summary, model, and context verbatim, and the date the index prints beside it. A count measures what a lab disclosed, not how its models behaved.',
    'disclosure',
    entityKey('disclosure:<provider>:<kind>:<entry_id>'),
    {
      kind: { type: 'text', meaning: 'report or notice.' },
      entry_id: {
        type: 'text',
        meaning:
          'The entry’s id on the index: a report’s slug, or a notice’s id without “notice-”.',
      },
      title: verbatim('The entry’s title'),
      summary: verbatim('The index’s one-sentence summary'),
      model: verbatim(
        'The model the report concerns, as the index prints it',
        'on a notice, and on every OpenAI row since its index stopped printing it on 2026-11-20 (disclosure_timelines.model has it)',
      ),
      observed_during: verbatim(
        'The context the behavior was observed in, as the index prints it',
        'on a notice, and on every OpenAI row since 2026-11-20 (disclosure_timelines.observed_during has it)',
      ),
      listed_on: {
        type: 'date',
        meaning:
          'The date the index prints beside the entry: a report’s last update, a notice’s posting date. It moves when a report is revised.',
      },
      entry_url: { type: 'text', meaning: 'The entry’s own page.' },
    },
  ),
  disclosure_timelines: entityView(
    'disclosure_timelines',
    'The dates printed on each report’s own page. That’s every “Label: value” line verbatim, the discovery date, and the disclosure date where the page prints one.',
    'disclosure_timeline',
    entityKey('disclosure_timeline:<provider>:<entry_id>'),
    {
      entry_id: { type: 'text', meaning: 'The report’s slug. It joins disclosures.entry_id.' },
      title: verbatim('The report page’s own title'),
      model: verbatim(
        'The model the report concerns, from the page’s scope line',
        'before 2026-11-20',
      ),
      observed_during: verbatim(
        'The context the behavior was observed in, from the page’s scope line',
        'before 2026-11-20, or when the scope line names no context',
      ),
      lines: {
        type: 'json',
        meaning:
          'Every “Label: value” line of the page’s metadata, verbatim and in page order, minus “Last updated” / “Report updated”: an array of {label, value} objects.',
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
        meaning:
          'A printed disclosure date (“Disclosure date” or “First posted”), when the page has one that is a single date.',
      },
    },
  ),
} satisfies Record<string, ExportTable>
