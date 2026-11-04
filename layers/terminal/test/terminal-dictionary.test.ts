import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vitest'

import * as schema from '~~/server/db/schema'
import { buildLlmsTxt } from '~~/server/utils/seo'
import { llmsTxtInput } from '../server/utils/crawler-pages'
import {
  COLUMN_DOCS,
  DATA_TYPES,
  DICTIONARY_CSV_COLUMNS,
  DICTIONARY_NAME,
  asOfColumns,
  dataDictionary,
  dictionaryCsv,
} from '../server/utils/terminal-dictionary'
import { ENTITY_SECURITIES } from '../server/utils/terminal-entities'
import { EXPORT_TABLES, csvLine } from '../server/utils/terminal-export'

// The dictionary cannot drift from the exports: every exported column has an
// entry, no entry names a column the export lost, and the as_of columns are
// the ones a point-in-time request really returns.

const db = drizzle(env.DB, { schema })
const T = '2026-10-01T00:00:00.000Z'

describe('the data dictionary', () => {
  it('documents every exported table, and only those', () => {
    expect(Object.keys(COLUMN_DOCS).sort()).toEqual(Object.keys(EXPORT_TABLES).sort())
    // /export/dictionary.<format> is served ahead of the table lookup.
    expect(Object.keys(EXPORT_TABLES)).not.toContain(DICTIONARY_NAME)
  })

  it('documents every exported column, and names none the export no longer has', () => {
    for (const table of Object.values(EXPORT_TABLES)) {
      expect(new Set(table.columns).size, `${table.name} names a column twice`).toBe(
        table.columns.length,
      )
      expect(Object.keys(COLUMN_DOCS[table.name]!.columns).sort(), table.name).toEqual(
        asOfColumns(table).sort(),
      )
    }
  })

  it('lists, per table, the columns ?as_of= really serves, or the refusal', async () => {
    for (const table of Object.values(EXPORT_TABLES)) {
      if (table.pointInTime === 'refused') {
        await expect(table.at(db, T), table.name).rejects.toThrow(table.asOfRefusal!)
        continue
      }
      expect((await table.at(db, T)).columns, table.name).toEqual(asOfColumns(table))
    }
  })

  it('states how each table answers as_of', () => {
    const dictionary = dataDictionary()
    for (const t of dictionary.tables) {
      const table = EXPORT_TABLES[t.name]!
      expect(t.as_of.mode, t.name).toBe(table.pointInTime)
      expect(t.as_of.note.length, t.name).toBeGreaterThan(20)
      // A written cut rule only where the table is cut; the others say it from the export.
      expect(COLUMN_DOCS[t.name]!.asOf !== undefined, t.name).toBe(table.pointInTime === 'cut')
      if (t.as_of.mode === 'refused') expect(t.as_of.note).toContain(table.asOfRefusal!.slice(1))
      const asOfOnly = t.columns.filter((c) => c.as_of_only).map((c) => c.name)
      expect(asOfOnly, t.name).toEqual(t.as_of.mode === 'rebuilt' ? ['as_of_verified'] : [])
    }
  })

  it('gives every table a key and two provenance columns, the URL and when', () => {
    for (const t of dataDictionary().tables) {
      expect(t.key.length, t.name).toBeGreaterThan(0)
      const provenance = t.columns.filter((c) => c.role === 'provenance')
      // source_runs carries started_at, entity_securities checked_on, in fetched_at's place.
      expect(provenance.map((c) => c.type).sort(), t.name).toEqual(
        t.name === 'entity_securities' ? ['date', 'text'] : ['text', 'timestamp'],
      )
      expect(t.columns.at(-1)!.role, t.name).toBe('provenance')
      for (const c of t.columns) {
        expect(c.meaning, `${t.name}.${c.name}`).toMatch(/^\S.{8,}[.)]$/s)
        expect(Object.keys(DATA_TYPES)).toContain(c.type)
      }
    }
  })

  it('keys entity_securities by entity and symbol, which no two rows share', () => {
    const t = dataDictionary().tables.find((x) => x.name === 'entity_securities')!
    const keys = ENTITY_SECURITIES.map((row) =>
      t.key.map((k) => row[k as keyof typeof row]).join('\n'),
    )
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('is named in llms.txt, which the MCP describe tool serves', () => {
    const text = buildLlmsTxt(
      llmsTxtInput({
        appName: 'Frontier Terminal',
        appUrl: 'https://example.com',
        appDescription: 'A fixture.',
        publicPages: [],
      }),
    )
    expect(text).toContain('https://example.com/export/dictionary.json')
    expect(text).toContain('https://example.com/export/dictionary.csv')
  })

  it('serves the same entries as one CSV row per table and column', () => {
    const dictionary = dataDictionary()
    const lines = dictionaryCsv(dictionary).split('\r\n')
    expect(lines[0]).toBe(DICTIONARY_CSV_COLUMNS.join(','))
    const columns = dictionary.tables.reduce((n, t) => n + t.columns.length, 0)
    expect(lines.filter(Boolean)).toHaveLength(columns + 1)
    const price = dictionary.tables
      .find((t) => t.name === 'prices_latest')!
      .columns.find((c) => c.name === 'input_per_mtok')!
    expect(lines).toContain(
      csvLine([
        'prices_latest',
        'input_per_mtok',
        'number',
        'USD per million tokens',
        true,
        null,
        false,
        price.meaning,
        'rebuilt',
      ]).trimEnd(),
    )
  })
})
