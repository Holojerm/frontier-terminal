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
import {
  EXPORT_HISTORY,
  EXPORT_TABLES,
  LICENSE_COLUMN,
  csvLine,
  licenseWindow,
} from '../server/utils/terminal-export'

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

  it('classifies every table for the license window, on a date column it really has', () => {
    expect(Object.keys(EXPORT_HISTORY).sort()).toEqual(Object.keys(EXPORT_TABLES).sort())
    const dictionary = dataDictionary()
    expect(dictionary.license).toContain('?history=full')
    for (const t of dictionary.tables) {
      const table = EXPORT_TABLES[t.name]!
      const rule = EXPORT_HISTORY[t.name]!
      expect(t.history.mode, t.name).toBe(rule.kind)
      expect(t.history.note.length, t.name).toBeGreaterThan(20)
      if (rule.kind === 'whole') {
        expect(t.history.dated, t.name).toEqual([])
        expect(t.history.full, t.name).toBeNull()
        // A whole table rebuilt before the window labels rows by when we first published them.
        if (rule.published !== null) expect(asOfColumns(table), t.name).toContain(rule.published)
        else expect(table.pointInTime, t.name).toBe('refused')
        continue
      }
      expect(t.history.dated, t.name).toEqual([...rule.dated])
      expect(t.history.full, t.name).toBe(`/export/${t.name}.csv?history=full`)
      for (const column of [...rule.dated, rule.published]) {
        expect(table.columns, `${t.name}.${column}`).toContain(column)
        const doc = t.columns.find((c) => c.name === column)!
        // A date, a stamp, or text that holds one of the two (claim_verdicts.detected_at):
        // either compares to the window's first day as a string.
        if (doc.type === 'text') expect(doc.meaning, `${t.name}.${column}`).toContain('YYYY-MM-DD')
        else expect(['date', 'timestamp'], `${t.name}.${column}`).toContain(doc.type)
      }
      // A SQL window is on the first dated column itself.
      if (rule.column) expect(rule.column.name, t.name).toBe(rule.dated[0])
    }
  })

  it('names the license column a full-history download adds, before source_url', () => {
    for (const table of Object.values(EXPORT_TABLES)) {
      if (EXPORT_HISTORY[table.name]!.kind === 'whole') continue
      const { columns } = licenseWindow(table.name, table, { history: 'full' }, '2026-08-06').table
      expect(columns.indexOf(LICENSE_COLUMN), table.name).toBe(columns.indexOf('source_url') - 1)
    }
    expect(dataDictionary().license).toContain(`${LICENSE_COLUMN} column`)
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
        'whole',
      ]).trimEnd(),
    )
  })
})
