import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import migration from '~~/server/db/migrations/0056_correct_lab_filing_provider.sql?raw'
import { ChangeRow, StoredEntityRow } from '#layers/core/server/pipeline/contracts'
import {
  issuerProviderFor,
  parseRevenueFilersBlock,
} from '../../server/pipeline/parsers/sec/revenue-filers'
import { parseCikWhitelistBlock } from '../../server/pipeline/parsers/sec/whitelist'
import { insertRows } from '#layers/core/server/pipeline/store'
import { fixtureText } from '#layers/core/test/pipeline/fixtures'

// Every filing was stored under provider 'other', so /alerts listed the
// 2026-11-19 "424B4 filed by Anthropic, PBC" under Lab "Other". The lanes now
// read a lab's own filings off the filer's CIK; migration 0056 sets the rows
// already stored. The 424B4's change row is copied from production
// (/api/alerts, alert e5bbb2b8…).

const db = drizzle(env.DB, { schema })
const ANTHROPIC_CIK = '0002130357'
const SPCX_CIK = '0001181412'
const HASH = (c: string) => c.repeat(64)

const filingPayload = (accession: string, cik: string, name: string, form: string) =>
  JSON.stringify({
    accession_no: accession,
    form,
    file_date: '2026-11-19',
    ciks: [cik],
    display_names: [name],
    whitelist_cik: cik,
  })

const entity = (over: Partial<StoredEntityRow>): StoredEntityRow =>
  StoredEntityRow.parse({
    entity_key: 'filing:x',
    entity_type: 'filing',
    provider: 'other',
    snapshot_id: 'snap',
    content_hash: HASH('a'),
    payload: '{}',
    source_url: 'https://data.sec.gov/submissions/CIK0002130357.json',
    fetched_at: '2026-11-19T11:31:23.103Z',
    source_id: 'edgar-submissions-anthropic',
    first_seen_at: '2026-11-19T11:31:23.103Z',
    ...over,
  })

const FILER = entity({
  entity_key: 'filer:anthropic',
  entity_type: 'filer',
  provider: 'anthropic',
  payload: JSON.stringify({ provider: 'anthropic', cik: ANTHROPIC_CIK, name: 'Anthropic, PBC' }),
  source_id: 'edgar-fts-anthropic',
})
const F424B4 = filingPayload('0001628280-26-074944', ANTHROPIC_CIK, 'Anthropic, PBC', '424B4')
const SPCX_10Q = filingPayload(
  '0001181412-26-000099',
  SPCX_CIK,
  'SPACE EXPLORATION TECHNOLOGIES CORP',
  '10-Q',
)

const change = (id: string, key: string, json: string) =>
  ChangeRow.parse({
    id,
    entity_key: key,
    entity_type: 'filing',
    provider: 'other',
    change_type: 'added',
    before_hash: null,
    after_hash: HASH('b'),
    before_json: null,
    after_json: json,
    detected_at: '2026-11-19T11:31:23.103Z',
    source_url: 'https://data.sec.gov/submissions/CIK0002130357.json',
    fetched_at: '2026-11-19T11:31:23.103Z',
  })

async function runMigration() {
  const statements = migration
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean)
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)))
}

describe('issuerProviderFor', () => {
  const sourcesYaml = fixtureText('sources.yaml')
  const whitelist = new Map(parseCikWhitelistBlock(sourcesYaml))
  const filers = new Map(parseRevenueFilersBlock(sourcesYaml))
  // What refresh.ts does for a lab resolved from its own S-1.
  whitelist.set('ANTHROPIC', ANTHROPIC_CIK)
  filers.set('anthropic', { ticker: 'ANTHROPIC', relation: 'issuer' })

  it('gives a lab its own filings and leaves a parent’s and a supplier’s as other', () => {
    expect(issuerProviderFor(ANTHROPIC_CIK, filers, whitelist)).toBe('anthropic')
    expect(issuerProviderFor(SPCX_CIK, filers, whitelist)).toBe('other') // xAI's parent
    expect(issuerProviderFor('0001652044', filers, whitelist)).toBe('other') // Alphabet
    expect(issuerProviderFor('0001045810', filers, whitelist)).toBe('other') // NVIDIA
    expect(issuerProviderFor(null, filers, whitelist)).toBe('other')
  })
})

describe('migration 0056: a resolved lab’s filings', () => {
  beforeEach(async () => {
    await db.delete(schema.changes)
    await db.delete(schema.entities)
  })

  it('moves the 424B4 and its cited change to Anthropic, and leaves SpaceX’s 10-Q as other', async () => {
    await insertRows(db, 'entities', [
      FILER,
      entity({ entity_key: 'filing:0001628280-26-074944', payload: F424B4 }),
      entity({
        entity_key: 'filing:0001181412-26-000099',
        payload: SPCX_10Q,
        source_id: 'edgar-submissions-spcx',
      }),
    ])
    await insertRows(db, 'changes', [
      change(
        '1d9e7a5319a0920bbfd44222c1cbb298cb243593127a18855cebaf66718cbe16',
        'filing:0001628280-26-074944',
        F424B4,
      ),
      change(HASH('c'), 'filing:0001181412-26-000099', SPCX_10Q),
    ])
    await runMigration()
    // A second run is a no-op.
    await runMigration()

    const providers = async (table: typeof schema.entities | typeof schema.changes) =>
      Object.fromEntries(
        (await db.select().from(table)).map((r) => [r.entity_key, r.provider] as const),
      )
    expect(await providers(schema.entities)).toEqual({
      'filer:anthropic': 'anthropic',
      'filing:0001628280-26-074944': 'anthropic',
      'filing:0001181412-26-000099': 'other',
    })
    expect(await providers(schema.changes)).toEqual({
      'filing:0001628280-26-074944': 'anthropic',
      'filing:0001181412-26-000099': 'other',
    })
    const ids = (await db.select().from(schema.changes)).map((c) => c.id)
    expect(ids).toContain('1d9e7a5319a0920bbfd44222c1cbb298cb243593127a18855cebaf66718cbe16')
  })
})
