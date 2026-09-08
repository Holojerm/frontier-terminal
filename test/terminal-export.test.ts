import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { contentHash, contentHashOfText } from '../server/pipeline/contracts'
import { insertRows } from '../server/pipeline/store'
import {
  EXPORT_PAGE_SIZE,
  EXPORT_TABLES,
  collect,
  csvCell,
  csvChunks,
  csvLine,
  exportTable,
  jsonChunks,
  parseExportPath,
  streamOf,
} from '../server/utils/terminal-export'

// Bulk exports against a real D1: every table has provenance columns, the
// CSV is RFC 4180, the JSON parses back to the same rows, and a table larger
// than one page streams whole.

const db = drizzle(env.DB, { schema })

const PROV = {
  source_url: 'https://docs.x.ai/developers/models.md',
  fetched_at: '2026-09-07T10:00:01.000Z',
}

function priceEntity(slug: string, input: number) {
  const payload = {
    provider: 'xai',
    model_slug: slug,
    tier: 'standard',
    context_window: '500k',
    input_per_mtok: input,
    cached_input_per_mtok: null,
    output_per_mtok: input * 3,
    currency: 'USD',
    effective_from: null,
    effective_until: null,
    notes: 'has a comma, and "quotes"',
  }
  return {
    source_id: 'xai-models-md',
    entity_key: `model:xai:${slug}:standard`,
    entity_type: 'model',
    provider: 'xai',
    snapshot_id: 'xai-models-md:2026-09-07T10:00:01.000Z',
    content_hash: contentHash(payload),
    payload: JSON.stringify(payload),
    first_seen_at: PROV.fetched_at,
    ...PROV,
  }
}

beforeAll(async () => {
  await insertRows(db, 'snapshots', [
    {
      id: 'xai-models-md:2026-09-07T10:00:01.000Z',
      source_id: 'xai-models-md',
      content_hash: contentHashOfText('x'),
      raw_key: 'raw/xai-models-md/2026-09-07T10:00:01.000Z.md',
      http_status: 200,
      bytes: 1,
      ...PROV,
    },
  ])
  // More rows than one page, so the stream has to keep going.
  await insertRows(
    db,
    'entities',
    Array.from({ length: EXPORT_PAGE_SIZE + 5 }, (_, i) =>
      priceEntity(`grok-${String(i).padStart(3, '0')}`, i),
    ),
  )
  await insertRows(db, 'source_runs', [
    {
      id: 'survey:xai-models-md:2026-09-07T10:00:00.000Z',
      scope: 'survey',
      source_id: 'xai-models-md',
      started_at: '2026-09-07T10:00:00.000Z',
      status: 'baseline',
      detail: null,
      snapshot_id: 'xai-models-md:2026-09-07T10:00:01.000Z',
      added: 0,
      removed: 0,
      modified: 0,
      source_url: PROV.source_url,
    },
  ])
})

describe('the table registry', () => {
  it('serves exactly the seven tables and nothing else', () => {
    expect(Object.keys(EXPORT_TABLES)).toEqual([
      'snapshots',
      'prices_latest',
      'jobs_open',
      'incidents',
      'changes',
      'alerts',
      'source_runs',
    ])
    expect(exportTable('entities')).toBeNull()
    expect(exportTable('constructor')).toBeNull()
    expect(exportTable('prices_latest')!.name).toBe('prices_latest')
  })

  it('reads table and format off the path, since the router cannot split a segment', () => {
    expect(parseExportPath('/export/prices_latest.json?x=1')).toEqual({
      name: 'prices_latest',
      format: 'json',
    })
    expect(parseExportPath('/export/alerts.csv')).toEqual({ name: 'alerts', format: 'csv' })
    expect(parseExportPath('/export/alerts.txt')).toBeNull()
    expect(parseExportPath('/export/')).toBeNull()
    // A traversal spelling parses to a name the registry has never heard of.
    expect(exportTable(parseExportPath('/export/../etc.csv')!.name)).toBeNull()
  })

  it('always ends with the provenance columns — source_runs with its honest substitute', () => {
    for (const [name, table] of Object.entries(EXPORT_TABLES)) {
      const tail = table.columns.slice(-2)
      if (name === 'source_runs') {
        expect(table.columns).toContain('source_url')
        expect(table.columns).toContain('started_at')
        expect(table.columns).not.toContain('fetched_at')
      } else {
        expect(tail, name).toEqual(['source_url', 'fetched_at'])
      }
    }
  })
})

describe('CSV', () => {
  it('quotes per RFC 4180 and leaves plain values bare', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell(2.5)).toBe('2.5')
    expect(csvCell(null)).toBe('')
    expect(csvCell('a, b')).toBe('"a, b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvLine(['a', null, 1])).toBe('a,,1\r\n')
  })

  it('streams a header line then every row, across page boundaries', async () => {
    const table = exportTable('prices_latest')!
    const text = await collect(csvChunks(db, table))
    const lines = text.split('\r\n').filter(Boolean)
    expect(lines[0]).toBe(table.columns.join(','))
    expect(lines).toHaveLength(EXPORT_PAGE_SIZE + 5 + 1)
    // Flattened payload columns sit between the key columns and provenance.
    const cols = table.columns
    const first = lines[1]!.split(',')
    expect(first[cols.indexOf('entity_key')]).toBe('model:xai:grok-000:standard')
    expect(first[cols.indexOf('model_slug')]).toBe('grok-000')
    expect(first[cols.indexOf('input_per_mtok')]).toBe('0')
    expect(first.at(-1)).toBe(PROV.fetched_at)
    expect(first.at(-2)).toBe(PROV.source_url)
    expect(lines[1]).toContain('"has a comma, and ""quotes"""')
  })

  it('an empty table is a header alone', async () => {
    const text = await collect(csvChunks(db, exportTable('alerts')!))
    expect(text).toBe(`${exportTable('alerts')!.columns.join(',')}\r\n`)
  })
})

describe('JSON', () => {
  it('parses back to one object per row with every column present', async () => {
    const rows = JSON.parse(await collect(jsonChunks(db, exportTable('prices_latest')!))) as Record<
      string,
      unknown
    >[]
    expect(rows).toHaveLength(EXPORT_PAGE_SIZE + 5)
    expect(Object.keys(rows[0]!)).toEqual(exportTable('prices_latest')!.columns)
    expect(rows[0]).toMatchObject({ model_slug: 'grok-000', output_per_mtok: 0, ...PROV })
    expect(rows[0]!.cached_input_per_mtok).toBeNull()
  })

  it('an empty table is an empty array', async () => {
    expect(JSON.parse(await collect(jsonChunks(db, exportTable('changes')!)))).toEqual([])
    const runs = JSON.parse(await collect(jsonChunks(db, exportTable('source_runs')!)))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'baseline', source_url: PROV.source_url })
  })
})

describe('streamOf', () => {
  it('yields the same bytes the generator produced', async () => {
    const stream = streamOf(csvChunks(db, exportTable('snapshots')!))
    const text = await new Response(stream).text()
    expect(text.split('\r\n')[0]).toBe(exportTable('snapshots')!.columns.join(','))
    expect(text).toContain('raw/xai-models-md/2026-09-07T10:00:01.000Z.md')
  })
})
