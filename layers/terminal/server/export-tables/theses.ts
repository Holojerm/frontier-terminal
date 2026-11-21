// The thesis claims: measured readings and judged verdicts. Part of EXPORT_TABLES (server/registries/export-tables.ts), which fixes the order.

import { and, lte } from 'drizzle-orm'
import * as tables from '#server/db/schema'
import { plainTable, type ExportTable } from '#layers/core/server/utils/terminal-export-views'

export const CLAIM_TABLES = {
  claim_readings: plainTable(
    'claim_readings',
    'One row per thesis claim and data date: the measured value its kill condition is checked against, with the detail behind it (docs/theses/).',
    tables.claimReadings,
    {
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
    [tables.claimReadings.claim_id, tables.claimReadings.date],
    'a claim reading is rewritten in place while its data is revised, and the value it replaced is not kept.',
  ),
  claim_verdicts: plainTable(
    'claim_verdicts',
    'The judge’s verdict on each candidate event for a judged thesis claim, with its rationale and the facts we computed (a price cut’s size, an outage’s hours). Rows are never edited.',
    tables.claimVerdicts,
    {
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
    [tables.claimVerdicts.detected_at, tables.claimVerdicts.id],
    // Judged after the change it rates; held back until it was judged.
    async (_db, at) =>
      and(lte(tables.claimVerdicts.detected_at, at), lte(tables.claimVerdicts.judged_at, at)),
  ),
} satisfies Record<string, ExportTable>
