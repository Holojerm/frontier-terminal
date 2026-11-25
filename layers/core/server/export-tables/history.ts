// The change log, the Internet Archive history, and the alerts. Part of EXPORT_TABLES (server/registries/export-tables.ts), which fixes the order.

import { sql } from 'drizzle-orm'
import { alertsKnownAt, judgeCutoffAt } from '../utils/terminal-asof'
import * as tables from '#server/db/schema'
import {
  PROVIDER,
  changeHash,
  changeJson,
  plainTable,
  byColumn,
  type ExportTable,
} from '../utils/terminal-export-views'

// OpenRouter's per-model daily rows reach the change log as `ranking` changes
// with the row in before_json/after_json; the changes export leaves them out
// for the same reason rankings_daily is withdrawn (WITHDRAWN_EXPORTS).
const notRanking = sql`${tables.changes.entity_type} <> 'ranking'`

export const HISTORY_TABLES = {
  changes: plainTable(
    'changes',
    'The change log. Every tracked item added, removed, or modified, with its before and after values. Rows are never edited. OpenRouter ranking rows are left out (see rankings_daily on /data).',
    tables.changes,
    {
      id: {
        type: 'text',
        key: true,
        meaning:
          'SHA-256 (hex) of the entity key and the two content hashes, so the same change is never logged twice. A filed_fact change hashes its series, period, and accession instead; a guidance or guidance_check change, its filer, fiscal year and accessions; a gpu_price change, its GPU and UTC day; an adoption_series, data_center, rate_limit, pay_band or deal_score change, its rule, entity and period; a supplier_passage change, its rule, company and accession, plus the lab for each row after the first; a revenue_score change, its rule, lab and accession.',
      },
      entity_key: {
        type: 'text',
        meaning: 'The changed row’s entity_key, as the views above use it.',
      },
      entity_type: {
        type: 'text',
        meaning:
          'The kind of row: model, job, incident, disclosure, disclosure_timeline, filer, revenue, filing, document, offering, statement, commitment, concentration, shares, risk_factors, recommendation, filed_fact (a hyperscaler series point a new filing moved, cited by its alert), guidance (a capex figure an earnings release printed, against the previous one, cited by its alert), guidance_check (a 10-Q or 10-K’s year-to-date capex against that figure, cited by its alert), gpu_price (the H100 or B200 rental median on two reads seven days apart, cited by its alert), adoption_series (a package-download, coding-agent or Ramp series on two periods), data_center (an Epoch AI site added or moved), rate_limit (one model’s published rate limits on two snapshots), pay_band (a posted-pay cell on two weeks), deal_score (a filed figure and the press reports of a deal’s size it scored), revenue_score (a lab’s own filing and the press reports of its revenue it scored) or supplier_passage (the new passages of one supplier filing that tie it to a lab or cloud, with one more row for each further lab they name), each cited by its alert. OpenRouter ranking rows are left out.',
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
    [tables.changes.detected_at, tables.changes.id],
    byColumn(tables.changes.detected_at),
    undefined,
    undefined,
    notRanking,
  ),
  archived_prices: plainTable(
    'archived_prices',
    'Price history from before we watched the labs: one row per SKU per Internet Archive copy of the lab’s own pricing page that we could read. source_url is the copy, captured_at when the Archive saw the page, fetched_at when we read the copy. Never mixed into the live tables.',
    tables.archivedPrices,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'The first 32 hex characters of the SHA-256 of capture_id and entity_key.',
      },
      capture_id: {
        type: 'text',
        meaning:
          'The copy the row was read from: <era>:<14-digit Wayback timestamp>, as in archive_captures.',
      },
      entity_key: {
        type: 'text',
        meaning:
          'The SKU: model:<provider>:<slug>[:<tier>], the same key the live prices use, so /prices/<key> shows this row before the live ones.',
      },
      provider: PROVIDER,
      content_hash: {
        type: 'text',
        meaning: 'SHA-256 (hex) of payload. Two copies with the same hash printed the same row.',
      },
      payload: {
        type: 'json',
        meaning:
          'The row as the page printed it, in the prices_latest fields: model_slug, tier, the three $/MTok prices (null where the page printed none), currency, and notes.',
      },
      captured_at: {
        type: 'timestamp',
        meaning:
          'When the Internet Archive captured the page, in UTC: the moment these prices were on it.',
      },
      original_url: { type: 'text', meaning: 'The lab’s own pricing page the Archive captured.' },
      basis: {
        type: 'text',
        meaning: 'Always archived: read from a copy, not observed by this site.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning:
          'The Wayback Machine copy (https://web.archive.org/web/<timestamp>id_/<original_url>).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When we read the copy back from the Archive, in UTC.',
      },
    },
    [tables.archivedPrices.captured_at, tables.archivedPrices.id],
    byColumn(tables.archivedPrices.captured_at),
  ),
  archived_hiring: plainTable(
    'archived_hiring',
    'Hiring history from before we read the labs’ job boards: open roles per Internet Archive copy of each lab’s own board that we could read. One board row per copy, and one row per department when the copy lists every role. source_url is the copy, captured_at when the Archive saw the board, fetched_at when we read the copy. Never mixed into the live tables.',
    tables.archivedHiring,
    {
      id: {
        type: 'text',
        key: true,
        meaning:
          'The first 32 hex characters of the SHA-256 of capture_id and the row’s scope or department.',
      },
      capture_id: {
        type: 'text',
        meaning:
          'The copy the count was read from: <era>:<14-digit Wayback timestamp>, as in archive_captures.',
      },
      provider: PROVIDER,
      scope: {
        type: 'text',
        meaning:
          'board (open roles on the whole board; one per copy) or department (one per department, when the copy lists every role; they sum to the board row).',
      },
      label: {
        type: 'text',
        nullable: true,
        meaning: 'The department as the board printed it then. Null on the board row.',
      },
      department_id: {
        type: 'text',
        nullable: true,
        meaning:
          'The board’s own id for the department (Greenhouse, Ashby), where the copy prints one. Null on the board row and on Lever boards.',
      },
      department: {
        type: 'text',
        nullable: true,
        meaning:
          'The live department the row files under: today’s label for the same department_id where the board’s id ties them, else the label as printed. Null on the board row.',
      },
      open_roles: {
        type: 'integer',
        unit: 'roles',
        meaning: 'Open roles the copy listed (department rows) or stated (board row).',
      },
      captured_at: {
        type: 'timestamp',
        meaning:
          'When the Internet Archive captured the board, in UTC: the moment these roles were open on it.',
      },
      original_url: { type: 'text', meaning: 'The lab’s own job board the Archive captured.' },
      basis: {
        type: 'text',
        meaning: 'Always archived: read from a copy, not observed by this site.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning:
          'The Wayback Machine copy (https://web.archive.org/web/<timestamp>id_/<original_url>).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When we read the copy back from the Archive, in UTC.',
      },
    },
    [tables.archivedHiring.captured_at, tables.archivedHiring.id],
    byColumn(tables.archivedHiring.captured_at),
  ),
  archived_gpu_prices: plainTable(
    'archived_gpu_prices',
    'GPU rental price history from before our GPU price checks began: one row per priced configuration per Internet Archive copy of the provider’s own price page that we could read, normalized like the live rows (recipe_observations, gpu-*). source_url is the copy, captured_at when the Archive saw the page, fetched_at when we read the copy. Never mixed into the live tables, the Compute thesis or the alerts.',
    tables.archivedGpuPrices,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'The first 32 hex characters of the SHA-256 of capture_id and key.',
      },
      capture_id: {
        type: 'text',
        meaning:
          'The copy the row was read from: <era>:<14-digit Wayback timestamp>, as in archive_captures.',
      },
      provider: {
        type: 'text',
        meaning:
          'The GPU provider: lambda, coreweave, nebius, crusoe, together, digitalocean, verda (DataCrunch until 2025), oracle, or google (Google Cloud).',
      },
      key: {
        type: 'text',
        meaning:
          'The configuration: GPU, form factor, label, GPUs per instance, region and config as printed, the same key the live gpu-* recipes store. A page that renamed a row starts a new key.',
      },
      gpu: { type: 'text', meaning: 'H100 or B200.' },
      value: {
        type: 'number',
        unit: 'USD per GPU-hour',
        meaning:
          'The on-demand price, an instance price divided by its GPUs where the page priced the instance.',
      },
      payload: {
        type: 'json',
        meaning:
          'The row as the page printed it, in the live gpu-* payload: provider, gpu, form_factor, counted (false for PCIe and NVL cards, left out of the median), label, gpus_per_instance, instance_usd_per_hour, region, config, and the spot price where the page printed one.',
      },
      captured_at: {
        type: 'timestamp',
        meaning:
          'When the Internet Archive captured the page, in UTC: the moment these prices were on it.',
      },
      original_url: {
        type: 'text',
        meaning: 'The provider’s own price page the Archive captured.',
      },
      basis: {
        type: 'text',
        meaning: 'Always archived: read from a copy, not observed by this site.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning:
          'The Wayback Machine copy (https://web.archive.org/web/<timestamp>id_/<original_url>).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When we read the copy back from the Archive, in UTC.',
      },
    },
    [tables.archivedGpuPrices.captured_at, tables.archivedGpuPrices.id],
    byColumn(tables.archivedGpuPrices.captured_at),
  ),
  archived_incidents: plainTable(
    'archived_incidents',
    'Status-page incident history from before our status feed checks began: one row per incident any Internet Archive copy of a lab’s own status feed listed, in the state the newest such copy gives it, shaped like the live incident rows. source_url is that copy, captured_at when the Archive saw the feed, fetched_at when we read the copy. Never mixed into the live tables, the incident windows or the alerts.',
    tables.archivedIncidents,
    {
      id: {
        type: 'text',
        key: true,
        meaning: '<provider>:<incident_id>: one row per incident, however many copies listed it.',
      },
      provider: PROVIDER,
      incident_id: {
        type: 'text',
        meaning:
          'The feed’s own id: a Statuspage incident code, an incident.io ULID (OpenAI from February 2025), a Google Cloud incident id or an xAI incident guid. The same ids the live lanes use, where the feed is the same.',
      },
      title: { type: 'text', meaning: 'The incident’s title, as the feed printed it.' },
      impact: {
        type: 'text',
        nullable: true,
        meaning:
          'In the vendor’s own vocabulary (Google low/medium/high, xAI’s severity). Null where the feed publishes none: Statuspage’s Atom history and incident.io’s RSS print no impact.',
      },
      status: {
        type: 'text',
        meaning: 'The newest status the newest copy gave, lowercased as the live rows are.',
      },
      started_at: {
        type: 'timestamp',
        meaning:
          'The start the feed states, in UTC: the oldest update on a Statuspage feed (to the minute), the moment the id was minted on incident.io (the live API’s created_at), Google’s begin, xAI’s pubDate.',
      },
      resolved_at: {
        type: 'timestamp',
        nullable: true,
        meaning:
          'The end the feed states, in UTC. Null while the newest copy shows it open, which may mean no later copy was taken, not that it stayed open.',
      },
      components: {
        type: 'json',
        meaning: 'The components or products the feed named, sorted; [] where it named none.',
      },
      incident_url: { type: 'text', meaning: 'The incident’s page on the lab’s status site.' },
      capture_id: {
        type: 'text',
        meaning:
          'The newest copy that listed the incident: <era>:<14-digit Wayback timestamp>, as in archive_captures.',
      },
      captured_at: {
        type: 'timestamp',
        meaning: 'When the Internet Archive captured that newest copy, in UTC.',
      },
      first_captured_at: {
        type: 'timestamp',
        meaning: 'When the Internet Archive captured the oldest copy that listed the incident.',
      },
      original_url: {
        type: 'text',
        meaning: 'The lab’s own status feed the Archive captured.',
      },
      basis: {
        type: 'text',
        meaning: 'Always archived: read from a copy, not observed by this site.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning:
          'The Wayback Machine copy (https://web.archive.org/web/<timestamp>id_/<original_url>).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When we read the copy back from the Archive, in UTC.',
      },
    },
    [tables.archivedIncidents.captured_at, tables.archivedIncidents.id],
    byColumn(tables.archivedIncidents.captured_at),
  ),
  archived_rate_limits: plainTable(
    'archived_rate_limits',
    'Rate-limit history from before we read the labs’ limits pages: one row per limit per Internet Archive copy of Anthropic’s rate-limit page we could read, from March 2024. Keyed as the live limits-anthropic recipe keys its rows. source_url is the copy, captured_at when the Archive saw the page. Never mixed into the live tables.',
    tables.archivedRateLimits,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'The first 32 hex characters of the SHA-256 of capture_id and key.',
      },
      capture_id: {
        type: 'text',
        meaning:
          'The copy the row was read from: <era>:<14-digit Wayback timestamp>, as in archive_captures.',
      },
      provider: PROVIDER,
      recipe_id: {
        type: 'text',
        meaning: 'The live recipe the row continues (limits-anthropic), as in recipe_observations.',
      },
      key: {
        type: 'text',
        meaning: '<model>|<tier>|<metric>, the key the live recipe uses.',
      },
      model: {
        type: 'text',
        meaning:
          'The model as the page printed it, or for a usage-tier row what the column states: spend cap, credit purchase to reach tier, max credit purchase, or wait to reach tier.',
      },
      tier: {
        type: 'text',
        meaning:
          'The usage tier, with “Build Tier 1” read as Tier 1 (Anthropic’s 2024 name for it).',
      },
      metric: {
        type: 'text',
        meaning:
          'RPM, TPM, TPD, ITPM or OTPM for a rate; USD per month, USD or days for a usage-tier row.',
      },
      value: {
        type: 'number',
        nullable: true,
        unit: 'the row’s metric',
        meaning: 'The limit as printed. Null where the page printed no figure (N/A).',
      },
      payload: {
        type: 'json',
        meaning:
          'model, tier and metric, and the tier label and column header as the copy printed them.',
      },
      captured_at: {
        type: 'timestamp',
        meaning:
          'When the Internet Archive captured the page, in UTC: the moment these limits were on it.',
      },
      original_url: {
        type: 'text',
        meaning: 'The lab’s own rate-limit page the Archive captured.',
      },
      basis: {
        type: 'text',
        meaning: 'Always archived: read from a copy, not observed by this site.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning:
          'The Wayback Machine copy (https://web.archive.org/web/<timestamp>id_/<original_url>).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When we read the copy back from the Archive, in UTC.',
      },
    },
    [tables.archivedRateLimits.captured_at, tables.archivedRateLimits.id],
    byColumn(tables.archivedRateLimits.captured_at),
  ),
  archive_captures: plainTable(
    'archive_captures',
    'Every Internet Archive copy the price-, hiring-, GPU-price- and incident-history backfill considered: read (with how many rows it gave) or skipped, with the reason. A skipped copy gave no rows; nothing on it was guessed.',
    tables.archiveCaptures,
    {
      id: {
        type: 'text',
        key: true,
        meaning: 'The copy: <era>:<14-digit Wayback timestamp>.',
      },
      era: {
        type: 'text',
        meaning:
          'Which shape of the lab’s pricing page, job board or status feed, or GPU provider’s price page, the copy is read as (layers/terminal/server/pipeline/archive/eras.ts, hiring-eras.ts, gpu-eras.ts, status-eras.ts).',
      },
      provider: PROVIDER,
      original_url: {
        type: 'text',
        meaning:
          'The lab’s own pricing page, job board or status feed, or the GPU provider’s price page, the Archive captured.',
      },
      captured_at: {
        type: 'timestamp',
        meaning: 'When the Internet Archive captured the page, in UTC.',
      },
      status: {
        type: 'text',
        meaning:
          'parsed (its rows are in archived_prices, archived_hiring, archived_gpu_prices, archived_incidents or archived_rate_limits, by axis) or skipped (no rows; detail says why).',
      },
      detail: {
        type: 'text',
        nullable: true,
        meaning:
          'Why a skipped copy was skipped, in the parser’s or the fetch’s own words. On a read job board, what it held beyond the counts (a paged list: total only); on a read status feed, what it listed that isn’t an incident row (maintenances, other products).',
      },
      content_hash: {
        type: 'text',
        nullable: true,
        meaning: 'SHA-256 (hex) of the copy’s text. Null when the fetch failed.',
      },
      raw_key: {
        type: 'text',
        nullable: true,
        meaning:
          'Key of the saved copy in this site’s object store (R2). Null when the fetch failed.',
      },
      bytes: {
        type: 'integer',
        nullable: true,
        unit: 'bytes',
        meaning: 'Size of the copy as read. Null when the fetch failed.',
      },
      rows: {
        type: 'integer',
        meaning:
          'How many rows the copy gave, in archived_prices, archived_hiring or archived_gpu_prices (see axis). On axis status, how many incidents it listed; each is one archived_incidents row however many copies listed it.',
      },
      covers_from: {
        type: 'timestamp',
        nullable: true,
        meaning:
          'Axis status only: the oldest incident start the copy lists, in UTC. A feed lists only its newest incidents, so the copy speaks for incidents that started from here to captured_at. Null on other axes and on a copy that listed none.',
      },
      axis: {
        type: 'text',
        meaning:
          'pricing (a lab’s pricing page; rows in archived_prices), hiring (a lab’s job board; rows in archived_hiring), gpu (a GPU provider’s price page; rows in archived_gpu_prices), status (a lab’s status feed; incidents in archived_incidents) or limits (a lab’s rate-limit page; rows in archived_rate_limits).',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning:
          'The Wayback Machine copy (https://web.archive.org/web/<timestamp>id_/<original_url>).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When we read the copy (or tried to), in UTC.',
      },
    },
    [tables.archiveCaptures.captured_at, tables.archiveCaptures.id],
    byColumn(tables.archiveCaptures.captured_at),
  ),
  alerts: plainTable(
    'alerts',
    'Every alert fired, with the change ids it cites and the rule that produced it.',
    tables.alerts,
    {
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
          'What wrote it: agent-judge (the judge routine), or a deterministic rule: s1-floor, periodic-floor, cik-resolved, model-floor, prospectus-floor, hiring-rollup, filed-fact-floor, guidance-floor, gpu-median-floor, adoption-floor, datacenter-floor, limits-floor, pay-floor, deal-score-floor, revenue-score-floor, supplier-passage-floor.',
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
    [tables.alerts.created_at, tables.alerts.id],
    async (db, at) => alertsKnownAt(at, await judgeCutoffAt(db, at)),
  ),
} satisfies Record<string, ExportTable>
