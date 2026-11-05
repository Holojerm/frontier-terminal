// An export table as an Apache Parquet file, for the bulk feed
// (terminal-bulk.ts). Same rows and columns as the CSV, typed by the data
// dictionary (terminal-dictionary.ts › COLUMN_DOCS), gzip-compressed.
//
// The writer is hyparquet-writer: plain JavaScript, so it runs in workerd with
// no WASM to instantiate. Its own codec is snappy; gzip comes from workerd's
// node:zlib (nodejs_compat), and on the production tables it writes files
// about a third smaller than snappy and a quarter smaller than the gzipped
// CSV. Not zstd: workerd's zstdCompressSync throws "Unexpected end of file"
// once a page compresses to more than ~40 KB, which failed every build of
// snapshots and jobs_open on 2026-11-05 (layers/terminal/test/terminal-parquet.test.ts
// keeps a page that size in the tests). It is fed one row group at a time and flushes each group's bytes out of
// its buffer, so a build holds the compressed file so far plus one group of
// decoded rows, never the table.
//
// Values are verbatim where the CSV defuses them: the formula apostrophe is a
// spreadsheet's problem, and nothing executes a Parquet cell. A timestamp is
// stored as its UTC instant in microseconds, so a vendor stamp's offset is not
// kept (the CSV and JSON keep it as written). A JSON column holds the same
// JSON value, re-serialized compactly.

import { gzipSync } from 'node:zlib'

import { ByteWriter, ParquetWriter } from 'hyparquet-writer/src/index.js'

import type { DictionaryType } from '../../shared/utils/terminal-types'
import { COLUMN_DOCS } from './terminal-dictionary'
import { LICENSE_COLUMN, type ExportTable } from './terminal-export'

type Row = Record<string, unknown>
type WriterOptions = ConstructorParameters<typeof ParquetWriter>[0]
type SchemaElement = WriterOptions['schema'][number]
type KeyValue = NonNullable<WriterOptions['kvMetadata']>[number]
type ColumnSource = Parameters<ParquetWriter['write']>[0]['columnData'][number]

/**
 * A row group closes at whichever comes first: this many rows, or this many
 * characters of cell text. The second bounds what a wide table (changes, with
 * a row's JSON before and after) holds decoded at once, whatever its width.
 */
export const PARQUET_ROW_GROUP_ROWS = 10_000
export const PARQUET_ROW_GROUP_BYTES = 4 * 1024 * 1024

export const PARQUET_CODEC = 'GZIP' satisfies WriterOptions['codec']
const PARQUET_COMPRESSORS: WriterOptions['compressors'] = {
  GZIP: (input) => gzipSync(input),
}

/** The prefix of every key-value metadata entry the files carry. */
export const PARQUET_METADATA_PREFIX = 'frontier_terminal.'

/** The physical and logical type each dictionary type is written as. Every column is OPTIONAL. */
const PARQUET_TYPES: Readonly<Record<DictionaryType, Omit<SchemaElement, 'name'>>> = {
  text: { type: 'BYTE_ARRAY', converted_type: 'UTF8', logical_type: { type: 'STRING' } },
  integer: { type: 'INT64', converted_type: 'INT_64' },
  number: { type: 'DOUBLE' },
  timestamp: {
    type: 'INT64',
    converted_type: 'TIMESTAMP_MICROS',
    logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MICROS' },
  },
  date: { type: 'INT32', converted_type: 'DATE', logical_type: { type: 'DATE' } },
  json: { type: 'BYTE_ARRAY', converted_type: 'JSON', logical_type: { type: 'JSON' } },
  boolean: { type: 'BOOLEAN' },
}

/** The dictionary type of `table`'s `column`. The license column a full file adds is text. */
export function columnType(table: string, column: string): DictionaryType {
  if (column === LICENSE_COLUMN) return 'text'
  const doc = COLUMN_DOCS[table]?.columns[column]
  if (!doc) throw new Error(`no data dictionary type for ${table}.${column}`)
  return doc.type
}

/** The Parquet schema of `table`: a root, then one OPTIONAL leaf per export column, in order. */
export function parquetSchema(table: ExportTable): SchemaElement[] {
  return [
    { name: 'root', num_children: table.columns.length },
    ...table.columns.map((name): SchemaElement => ({
      name,
      repetition_type: 'OPTIONAL',
      ...PARQUET_TYPES[columnType(table.name, name)],
    })),
  ]
}

const DAY_MS = 86_400_000

function fail(column: string, type: DictionaryType, value: unknown): never {
  throw new Error(`${column}: ${JSON.stringify(value)} is not a ${type}`)
}

/** An ISO-8601 stamp as microseconds since the epoch, keeping digits past the millisecond. */
export function timestampMicros(text: string): bigint | null {
  const ms = Date.parse(text)
  if (Number.isNaN(ms) || !/^\d{4}-\d{2}-\d{2}T/.test(text)) return null
  const extra = /T\d{2}:\d{2}:\d{2}\.\d{3}(\d{1,3})/.exec(text)?.[1] ?? ''
  return BigInt(ms) * 1000n + BigInt(extra.padEnd(3, '0'))
}

/** One cell as the column's Parquet type wants it, or null. A value that doesn't fit throws. */
export function parquetValue(type: DictionaryType, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null
  switch (type) {
    case 'text':
      return typeof value === 'string'
        ? value
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value)
    case 'integer': {
      if (typeof value === 'bigint') return value
      const n = Number(value)
      if (!Number.isSafeInteger(n) || (typeof value === 'string' && value.trim() === '')) {
        fail(column, type, value)
      }
      return BigInt(n)
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n) || (typeof value === 'string' && value.trim() === '')) {
        fail(column, type, value)
      }
      return n
    }
    case 'boolean':
      if (value === true || value === 1 || value === 'true') return true
      if (value === false || value === 0 || value === 'false') return false
      return fail(column, type, value)
    case 'date': {
      const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
      if (!match) return fail(column, type, value)
      return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS
    }
    case 'timestamp': {
      const micros = typeof value === 'string' ? timestampMicros(value) : null
      return micros ?? fail(column, type, value)
    }
    case 'json':
      if (typeof value !== 'string') return value
      try {
        return JSON.parse(value) as unknown
      } catch {
        // JSON text that doesn't parse is kept as a JSON string, not dropped.
        return value
      }
  }
}

/**
 * A ByteWriter that hands each row group's bytes to `chunks` when the writer
 * flushes, so its buffer holds one group at most. `offset` keeps counting the
 * whole file, which is what the footer's offsets are measured in.
 */
class ChunkWriter extends ByteWriter {
  readonly chunks: Uint8Array[] = []
  flush(): void {
    if (this.index === 0) return
    this.chunks.push(this.getBytes().slice())
    this.index = 0
  }
  override finish(): void {
    this.flush()
  }
}

/** The file's key-value metadata: `frontier_terminal.<key>` for each entry of `meta`. */
export function parquetMetadata(meta: Readonly<Record<string, string>>): KeyValue[] {
  return Object.entries(meta).map(([key, value]) => ({
    key: `${PARQUET_METADATA_PREFIX}${key}`,
    value,
  }))
}

/**
 * Collects rows of `table` into Parquet row groups. `add` takes each page of
 * rows as the export streams them; `finish` writes the footer and returns the
 * file. One instance per file.
 */
export function parquetBuilder(
  table: ExportTable,
  meta: Readonly<Record<string, string>>,
  limits: { rows: number; bytes: number } = {
    rows: PARQUET_ROW_GROUP_ROWS,
    bytes: PARQUET_ROW_GROUP_BYTES,
  },
) {
  const types = table.columns.map((c) => columnType(table.name, c))
  const writer = new ChunkWriter()
  const parquet = new ParquetWriter({
    writer,
    schema: parquetSchema(table),
    codec: PARQUET_CODEC,
    compressors: PARQUET_COMPRESSORS,
    kvMetadata: parquetMetadata(meta),
    createdBy: 'Frontier Terminal (hyparquet-writer)',
  })
  let columns: unknown[][] = table.columns.map(() => [])
  let buffered = 0
  let bufferedBytes = 0
  let rows = 0

  const writeGroup = () => {
    if (buffered === 0) return
    const columnData = table.columns.map((name, i): ColumnSource => ({
      name,
      data: columns[i]!,
      nullable: true,
    }))
    // Synchronous: ChunkWriter.flush returns nothing, so write never defers.
    void parquet.write({ columnData, rowGroupSize: buffered })
    columns = table.columns.map(() => [])
    buffered = 0
    bufferedBytes = 0
  }

  return {
    add(page: readonly Row[]) {
      for (const row of page) {
        table.columns.forEach((name, i) => {
          const value = row[name]
          bufferedBytes += typeof value === 'string' ? value.length : 8
          columns[i]!.push(parquetValue(types[i]!, name, value))
        })
        buffered++
        rows++
        if (buffered >= limits.rows || bufferedBytes >= limits.bytes) writeGroup()
      }
    },
    finish(): { body: Uint8Array<ArrayBuffer>; rows: number } {
      writeGroup()
      void parquet.finish()
      const body = new Uint8Array(writer.offset)
      let at = 0
      for (const chunk of writer.chunks) {
        body.set(chunk, at)
        at += chunk.byteLength
      }
      return { body, rows }
    },
  }
}
