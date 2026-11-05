import { describe, expect, test } from 'vitest'

import { contentHash } from '../../server/pipeline/contracts'
import { HIRING_ARCHIVE_ERAS, hiringEraById } from '../../server/pipeline/archive/hiring-eras'
import { hiringRows } from '../../server/pipeline/archive/rows'
import { captureInstant } from '../../server/pipeline/archive/wayback'
import { fixtureText, manifest, provenanceOf } from './fixtures'

// Golden tests for the archived job boards (archive/hiring-eras.ts): one
// Internet Archive capture per era, trimmed as fixtures/manifest.json says
// (the trim gives the same counts as the raw capture), each read twice for
// determinism. The totals below were checked against the captures by hand,
// and two pairs against each other: Anthropic's /departments a day before
// its HTML board (the nine roles only the API lists were all closed that
// day), and xAI's /jobs five days before its HTML board.

const W = (name: string) => fixtureText(`fixtures/hiring/wayback/${name}`)

// era, timestamp, fixture, board total, departments (null: total only)
const FIXTURES = [
  ['openai-greenhouse-2023', '20230710223640', 'openai-greenhouse-2023-07.html', 61, 20],
  ['openai-ashby-2024', '20250724103653', 'openai-ashby-2025-07.html', 318, 24],
  ['openai-ashby-2024', '20260819103654', 'openai-ashby-2026-08.html', 733, 33],
  ['anthropic-lever-2023', '20230709181316', 'anthropic-lever-2023-07.html', 38, 10],
  ['anthropic-greenhouse-2024', '20240614214605', 'anthropic-greenhouse-2024-06.html', 114, 16],
  ['anthropic-departments-api', '20240613205232', 'anthropic-departments-2024-06.json', 123, 16],
  ['anthropic-job-boards-2025', '20250902161436', 'anthropic-job-boards-2025-09.html', 174, null],
  ['xai-greenhouse-2023', '20250206172319', 'xai-greenhouse-2025-02.html', 74, 11],
  ['xai-jobs-api-2023', '20250201175326', 'xai-jobs-2025-02.json', 70, null],
  ['xai-job-boards-2025', '20250901235524', 'xai-job-boards-2025-09.html', 201, null],
  ['mistral-lever-2023', '20250807224411', 'mistral-lever-2025-08.html', 67, 7],
  ['mistral-ashby-2026', '20260917150519', 'mistral-ashby-2026-09.html', 195, 11],
  ['deepmind-greenhouse-2023', '20250315181538', 'deepmind-greenhouse-2025-03.html', 47, 5],
  ['deepmind-job-boards-2025', '20250702184842', 'deepmind-job-boards-2025-07.html', 47, 4],
] as const

function read(era: string, ts: string, name: string) {
  const e = hiringEraById(era)!
  const text = W(name)
  const prov = provenanceOf(`wayback-${era}-${ts}`)
  const capture = { timestamp: ts, original: e.url, digest: ts }
  return {
    e,
    prov,
    out: e.parse(text),
    rows: hiringRows(e, capture, text, text.length, prov.fetched_at),
  }
}

const dept = (out: ReturnType<typeof read>['out'], label: string) =>
  out.departments?.find((d) => d.label === label)?.open_roles

describe('archived job boards', () => {
  test.each(FIXTURES)('%s %s is deterministic and counts every role', (era, ts, name, total, n) => {
    const { e, prov, out, rows } = read(era, ts, name)
    expect(contentHash(read(era, ts, name).out)).toBe(contentHash(out))
    expect(out.total).toBe(total)
    expect(out.departments?.length ?? null).toBe(n)
    if (out.departments) {
      expect(out.departments.reduce((s, d) => s + d.open_roles, 0)).toBe(total)
    }
    expect(prov.source_url).toBe(`https://web.archive.org/web/${ts}id_/${e.url}`)
    expect(rows.capture).toMatchObject({ status: 'parsed', axis: 'hiring', era })
    const board = rows.counts.filter((r) => r.scope === 'board')
    expect(board).toHaveLength(1)
    expect(board[0]).toMatchObject({
      open_roles: total,
      captured_at: captureInstant(ts),
      basis: 'archived',
      source_url: prov.source_url,
    })
    expect(rows.counts.length).toBe(1 + (n ?? 0))
  })

  test('every era has a fixture', () => {
    const covered = new Set(FIXTURES.map(([era]) => era))
    for (const era of HIRING_ARCHIVE_ERAS) expect(covered.has(era.id), era.id).toBe(true)
    for (const [, , name] of FIXTURES) {
      expect(manifest.fixtures.some((f) => f.path === `fixtures/hiring/wayback/${name}`)).toBe(true)
    }
  })

  test('the old Greenhouse board counts a nested role under its own department', () => {
    const { out } = read('xai-greenhouse-2023', '20250206172319', 'xai-greenhouse-2025-02.html')
    // "Finance" is a sub-department of "Other"; no role is counted under "Other" itself.
    expect(dept(out, 'Finance')).toBe(2)
    expect(dept(out, 'Other')).toBeUndefined()
    expect(dept(out, 'Data Center Operations')).toBe(13)
  })

  test('a paged job-boards capture gives the board’s own total and no departments', () => {
    const { out, rows } = read(
      'anthropic-job-boards-2025',
      '20250902161436',
      'anthropic-job-boards-2025-09.html',
    )
    expect(out.departments).toBeNull()
    expect(rows.capture.detail).toBe('page 1 of 4 lists 50 of 174 roles: total only')
  })

  test('the Greenhouse board API and the HTML board agree, a day apart', () => {
    const api = read(
      'anthropic-departments-api',
      '20240613205232',
      'anthropic-departments-2024-06.json',
    ).out
    const html = read(
      'anthropic-greenhouse-2024',
      '20240614214605',
      'anthropic-greenhouse-2024-06.html',
    ).out
    // The only departments that differ are the two whose roles closed on 2024-06-13.
    const differ = api.departments!.filter((d) => dept(html, d.label) !== d.open_roles)
    expect(differ.map((d) => [d.label, d.open_roles, dept(html, d.label)])).toEqual([
      ['Research', 32, 29],
      ['Responsible Scaling Policy', 8, 2],
    ])
  })

  test('a renamed Greenhouse department files under today’s label by its id', () => {
    const { rows } = read(
      'anthropic-greenhouse-2024',
      '20240614214605',
      'anthropic-greenhouse-2024-06.html',
    )
    const comms = rows.counts.find((r) => r.label === 'Communications & Marketing')!
    expect(comms).toMatchObject({ department_id: '4002047008', department: 'Communications' })
    // A department with no live id keeps its printed label.
    const rsp = rows.counts.find((r) => r.label === 'Responsible Scaling Policy')!
    expect(rsp.department).toBe('Responsible Scaling Policy')
  })

  test('a 2026 Ashby posting’s department is the root of its team', () => {
    const { out } = read('openai-ashby-2024', '20260819103654', 'openai-ashby-2026-08.html')
    expect(dept(out, 'Go To Market')).toBe(135)
    expect(dept(out, 'Scaling')).toBe(107)
    expect(dept(out, '(no department)')).toBeUndefined()
  })
})
