// Hiring at the listed companies: every role their boards have listed, and each read's counts. Part of EXPORT_TABLES (utils/terminal-export.ts), which fixes the order.

import { lte } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { plainTable, type ExportTable } from '../utils/terminal-export-views'

const BOARD_MEANING =
  'The board, as sources.yaml › listed_hiring_sources names it (listed-coreweave-greenhouse, listed-google-careers).'

const ticker = {
  type: 'text',
  meaning: 'The company’s US ticker (CRWV, NBIS, GLXY, HUT, CIFR, CBRS, ALAB, CRDO, GOOGL).',
} as const

export const LISTED_HIRING_TABLES = {
  listed_jobs: plainTable(
    'listed_jobs',
    'Every role the job boards of the listed companies around the labs have listed since our first read, open or closed: CoreWeave, Nebius, Galaxy, Hut 8, Cipher Digital, Cerebras, Astera Labs, Credo, and Google’s data-center roles only. A role is open at an instant when first_seen_at is at or before it and closed_at is null or after it. role_class is our rule’s reading of the board’s own title and department.',
    tables.listedJobs,
    {
      board_id: { type: 'text', key: true, meaning: BOARD_MEANING },
      job_id: { type: 'text', key: true, meaning: 'The board’s own id for the posting.' },
      ticker,
      title: { type: 'text', meaning: 'The posting’s title, verbatim.' },
      department: {
        type: 'text',
        nullable: true,
        meaning:
          'The board’s department label, verbatim (Google: its job categories, comma-separated). Null where the board files none.',
      },
      location: { type: 'text', nullable: true, meaning: 'Where the board places the role.' },
      published_at: {
        type: 'text',
        nullable: true,
        meaning: 'When the board says the posting went up, as it writes it.',
      },
      role_class: {
        type: 'text',
        meaning:
          'datacenter (data-center operations, site, construction, facilities and power), infrastructure (GPU and infrastructure engineering) or other: the title first, then the department. Recruiting, finance, legal and sales roles are other on any team.',
      },
      first_seen_at: { type: 'timestamp', meaning: 'The first read that listed the role, in UTC.' },
      closed_at: {
        type: 'timestamp',
        nullable: true,
        meaning:
          'The first read that no longer listed it, in UTC. Null while it is listed. A role that comes back is open again, with this cleared.',
      },
      source_url: {
        type: 'text',
        provenance: true,
        meaning: 'The board API read (Google: the careers feed, as the careers lane fetched it).',
      },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning: 'When the read the row’s content last changed at was fetched, in UTC.',
      },
    },
    [tables.listedJobs.board_id, tables.listedJobs.job_id],
    'A role’s title, department, class and closed_at are rewritten in place as later reads list it; cut on first_seen_at and closed_at for the board at an instant.',
    undefined,
    { ticker: tables.listedJobs.ticker },
  ),
  listed_hiring_reads: plainTable(
    'listed_hiring_reads',
    'One row per daily read of a listed company’s job board: how many roles it listed, how many our rule classes as data-center and as infrastructure work, and how many opened and closed since the read before. The counts are what the board showed at that read, never rebuilt. A failed read has no counts and says why.',
    tables.listedHiringReads,
    {
      id: { type: 'text', key: true, meaning: '<board_id>:<read_at>.' },
      board_id: { type: 'text', meaning: BOARD_MEANING },
      ticker,
      read_at: { type: 'timestamp', meaning: 'When we read the board, in UTC.' },
      status: { type: 'text', meaning: 'read, or failed.' },
      detail: { type: 'text', nullable: true, meaning: 'Why a failed read failed.' },
      total: {
        type: 'number',
        nullable: true,
        meaning:
          'Open roles on the board. Null on a failed read, and on Google’s, which is read for its data-center roles only.',
      },
      datacenter: {
        type: 'number',
        nullable: true,
        meaning: 'Open roles classed datacenter. Null on a failed read.',
      },
      infrastructure: {
        type: 'number',
        nullable: true,
        meaning: 'Open roles classed infrastructure. Null on a failed read and on Google’s.',
      },
      added: {
        type: 'number',
        nullable: true,
        meaning: 'Roles listed now that were not open at the read before (new or reopened).',
      },
      closed: {
        type: 'number',
        nullable: true,
        meaning: 'Roles open at the read before that this read no longer lists.',
      },
      content_hash: {
        type: 'text',
        nullable: true,
        meaning: 'SHA-256 (hex) of the board’s response, or of the archived feed for Google.',
      },
      raw_key: {
        type: 'text',
        nullable: true,
        meaning: 'Key of the board’s response in this site’s object store (R2).',
      },
      source_url: { type: 'text', provenance: true, meaning: 'The board API read.' },
      fetched_at: {
        type: 'timestamp',
        provenance: true,
        meaning:
          'When the response was fetched, in UTC (Google: when the careers lane fetched the feed).',
      },
    },
    [tables.listedHiringReads.id],
    async (_db, at) => lte(tables.listedHiringReads.read_at, at),
    undefined,
    { ticker: tables.listedHiringReads.ticker },
  ),
} satisfies Record<string, ExportTable>
