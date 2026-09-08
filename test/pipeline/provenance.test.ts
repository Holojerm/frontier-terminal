import { describe, expect, test } from 'vitest'

import {
  AlertRow,
  AshbyJobRow,
  ChangeRow,
  EntityRow,
  FilingRow,
  GreenhouseJobRow,
  OpenRouterModelRow,
  PriceRow,
  Provenance,
  SnapshotRow,
  contentHashOfText,
} from '../../server/pipeline/contracts'

// Provenance gate: a row without source_url + fetched_at must be impossible
// to validate, on every row schema in the system. Whatever insert path lands
// later inherits this by validating rows against these schemas first.

const goodSnapshot: SnapshotRow = {
  id: 'test:2026-08-25T11:10:40Z',
  source_id: 'openai-models-md',
  content_hash: contentHashOfText('payload'),
  raw_key: 'raw/openai-models-md/2026-08-25T11:10:40Z.md',
  http_status: 200,
  bytes: 11390,
  source_url: 'https://developers.openai.com/api/docs/models.md',
  fetched_at: '2026-08-25T11:10:40Z',
}

const withoutKey = <T extends object>(row: T, key: keyof T): Omit<T, typeof key> => {
  const copy = { ...row }
  delete copy[key]
  return copy
}

describe('provenance fields', () => {
  test('accepts an http(s) URL paired with a timezone-qualified ISO 8601 timestamp', () => {
    expect(SnapshotRow.safeParse(goodSnapshot).success).toBe(true)
    expect(
      Provenance.safeParse({
        source_url: 'http://data.sec.gov/submissions/CIK0001181412.json',
        fetched_at: '2026-08-25T11:10:55.123+02:00',
      }).success,
    ).toBe(true)
  })

  test.each([
    ['missing source_url', withoutKey(goodSnapshot, 'source_url')],
    ['missing fetched_at', withoutKey(goodSnapshot, 'fetched_at')],
    ['non-http source_url', { ...goodSnapshot, source_url: 'ftp://example.com/x' }],
    ['naive fetched_at (no timezone)', { ...goodSnapshot, fetched_at: '2026-08-25T11:10:40' }],
    ['empty source_url', { ...goodSnapshot, source_url: '' }],
    ['null fetched_at', { ...goodSnapshot, fetched_at: null }],
  ])('rejects a row with %s', (_label, row) => {
    expect(SnapshotRow.safeParse(row).success).toBe(false)
  })

  test.each([
    ['SnapshotRow', SnapshotRow],
    ['EntityRow', EntityRow],
    ['ChangeRow', ChangeRow],
    ['AlertRow', AlertRow],
    ['AshbyJobRow', AshbyJobRow],
    ['GreenhouseJobRow', GreenhouseJobRow],
    ['PriceRow', PriceRow],
    ['FilingRow', FilingRow],
    ['OpenRouterModelRow', OpenRouterModelRow],
  ])('%s requires both provenance fields', (_name, schema) => {
    const result = schema.safeParse({})
    expect(result.success).toBe(false)
    const paths = result.error!.issues.map((i) => i.path.join('.'))
    expect(paths).toContain('source_url')
    expect(paths).toContain('fetched_at')
  })

  test('ChangeRow enforces the hash/change_type invariants', () => {
    const base = {
      id: 'c1',
      entity_key: 'job:xai:1',
      entity_type: 'job',
      provider: 'xai',
      before_json: null,
      after_json: '{}',
      detected_at: goodSnapshot.fetched_at,
      source_url: goodSnapshot.source_url,
      fetched_at: goodSnapshot.fetched_at,
    }
    const hash = contentHashOfText('x')
    expect(
      ChangeRow.safeParse({ ...base, change_type: 'added', before_hash: null, after_hash: hash })
        .success,
    ).toBe(true)
    expect(
      ChangeRow.safeParse({ ...base, change_type: 'added', before_hash: hash, after_hash: hash })
        .success,
    ).toBe(false)
    expect(
      ChangeRow.safeParse({ ...base, change_type: 'removed', before_hash: hash, after_hash: hash })
        .success,
    ).toBe(false)
    expect(
      ChangeRow.safeParse({ ...base, change_type: 'modified', before_hash: null, after_hash: hash })
        .success,
    ).toBe(false)
  })
})
