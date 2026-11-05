import { describe, expect, test } from 'vitest'

import {
  HIRING_ARCHIVE_ERAS,
  HIRING_ARCHIVE_UNTIL,
  HIRING_DEPARTMENT_IDS,
  hiringEraById,
  liveDepartment,
} from '../server/pipeline/archive/hiring-eras'
import { ARCHIVE_FROM } from '../server/pipeline/archive/eras'
import { archiveRawKey, hiringRows } from '../server/pipeline/archive/rows'
import {
  parseAshbyBoardHtml,
  parseGreenhouseBoardHtml,
  parseGreenhouseJobBoardsHtml,
  parseGreenhouseJobsJson,
  parseLeverBoardHtml,
} from '../server/pipeline/parsers/hiring/wayback-boards'
import { readArchiveSources } from '../server/utils/terminal-sources'
import sourcesYaml from '~~/sources.yaml?raw'

// The archived job boards' pure half: the era windows, the rules each board
// parser enforces (a board that lists nothing or pages its list is never a
// count of the page), and the rows one capture becomes. The golden tests
// over real captures are in pipeline/wayback-hiring.golden.test.ts.

const FETCHED = '2026-11-05T00:00:00.000Z'
const capture = (era: string, timestamp = '20250101000000') => ({
  timestamp,
  original: hiringEraById(era)!.url,
  digest: timestamp,
})
const remix = (jobPosts: object) =>
  `<html><script>window.__remixContext = ${JSON.stringify({
    state: { loaderData: { 'routes/$url_token': { jobPosts } } },
  })};</script></html>`

describe('hiring eras', () => {
  test('every era is a window between 2023 and the day the live lane began', () => {
    for (const era of HIRING_ARCHIVE_ERAS) {
      expect(era.from < era.until, era.id).toBe(true)
      expect(era.from >= ARCHIVE_FROM, era.id).toBe(true)
      expect(era.until <= HIRING_ARCHIVE_UNTIL[era.provider], era.id).toBe(true)
    }
    expect(new Set(HIRING_ARCHIVE_ERAS.map((e) => e.id)).size).toBe(HIRING_ARCHIVE_ERAS.length)
  })

  test('a department maps to a live label only by the board’s own id', () => {
    expect(liveDepartment('anthropic', '4048023008', 'Marketing')).toBe('Marketing & Brand')
    expect(liveDepartment('anthropic', null, 'Research')).toBe('Research')
    expect(liveDepartment('mistral', null, 'Engineering & Infra')).toBe('Engineering & Infra')
    expect(liveDepartment('google', '238125', 'Bard')).toBe('Bard')
    for (const ids of Object.values(HIRING_DEPARTMENT_IDS)) {
      for (const [id, label] of Object.entries(ids)) {
        expect(id).toMatch(/^(\d+|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$/)
        expect(label.trim()).toBe(label)
      }
    }
  })

  test('saved bytes keep their format in the key', () => {
    expect(archiveRawKey(hiringEraById('anthropic-departments-api')!, '20240613205232')).toBe(
      'archive/wayback/anthropic-departments-api/20240613205232.json',
    )
    expect(archiveRawKey(hiringEraById('mistral-lever-2023')!, '20250807224411')).toBe(
      'archive/wayback/mistral-lever-2023/20250807224411.html',
    )
  })

  test('sources.yaml records the Archive’s terms for the boards', () => {
    const hiring = readArchiveSources(sourcesYaml).find((s) => s.id === 'wayback-hiring')
    expect(hiring).toMatchObject({ rights: 'not-cleared', verdict: 'include' })
    expect(hiring!.terms).toContain('no title, posting text, location or')
  })
})

describe('archived board parsers', () => {
  test('an empty Lever page is a skip, not zero roles', () => {
    expect(() => parseLeverBoardHtml('<html><body>No job postings</body></html>')).toThrow(
      'lever: no postings on the page',
    )
  })

  test('a Greenhouse board page with no openings is a skip', () => {
    expect(() =>
      parseGreenhouseBoardHtml('<h2 id="board_title">Current Job Openings</h2></html>'),
    ).toThrow('no open role listed')
  })

  test('a Greenhouse opening whose department has no heading is a skip', () => {
    const page =
      '<h2 id="board_title">Current Job Openings</h2><div class="opening" department_id="7"><a href="/x/jobs/1">A</a></div>'
    expect(() => parseGreenhouseBoardHtml(page)).toThrow('department 7 has no heading')
  })

  test('a paged job-boards capture gives the stated total only', () => {
    const out = parseGreenhouseJobBoardsHtml(
      remix({ count: 1, page: 1, total: 60, total_pages: 2, data: [{ id: 1 }] }),
    )
    expect(out).toMatchObject({ total: 60, departments: null })
    expect(() =>
      parseGreenhouseJobBoardsHtml(
        remix({ count: 1, page: 2, total: 60, total_pages: 2, data: [{ id: 1 }] }),
      ),
    ).toThrow('capture is page 2')
  })

  test('a one-page job-boards capture counts every role by department', () => {
    const out = parseGreenhouseJobBoardsHtml(
      remix({
        count: 3,
        page: 1,
        total: 3,
        total_pages: 1,
        data: [
          { id: 1, department: { id: 9, name: 'GenAI' } },
          { id: 2, department: { id: 9, name: 'GenAI' } },
          { id: 3, department: null },
        ],
      }),
    )
    expect(out.departments).toEqual([
      { label: '(no department)', department_id: null, open_roles: 1 },
      { label: 'GenAI', department_id: '9', open_roles: 2 },
    ])
  })

  test('Greenhouse /jobs refuses a list shorter than its own meta.total', () => {
    expect(() =>
      parseGreenhouseJobsJson(JSON.stringify({ jobs: [{ id: 1 }], meta: { total: 2 } })),
    ).toThrow('meta.total 2 but 1 jobs')
  })

  test('Ashby leaves unlisted postings out and says so', () => {
    const page = `<html><script>window.__appData = ${JSON.stringify({
      jobBoard: {
        teams: [],
        jobPostings: [
          { id: 'a', departmentId: 'd', departmentName: 'Research', isListed: true },
          { id: 'b', departmentId: 'd', departmentName: 'Research', isListed: false },
        ],
      },
    })};\n</script></html>`
    expect(parseAshbyBoardHtml(page)).toEqual({
      total: 1,
      departments: [{ label: 'Research', department_id: 'd', open_roles: 1 }],
      note: '1 unlisted posting(s) not counted',
    })
  })
})

describe('hiringRows', () => {
  const era = hiringEraById('mistral-lever-2023')!
  const page =
    '<div class="postings-group"><div class="posting-category-title large-category-label">Research</div>' +
    '<div class="posting" data-qa-posting-id="a"></div><div class="posting" data-qa-posting-id="b"></div></div>' +
    '<div class="postings-group"><div class="posting-category-title large-category-label">Solutions</div>' +
    '<div class="posting" data-qa-posting-id="c"></div></div></html>'

  test('a capture becomes one board row and one row per department', () => {
    const out = hiringRows(era, capture(era.id), page, page.length, FETCHED)
    expect(out.capture).toMatchObject({ status: 'parsed', axis: 'hiring', rows: 3, detail: null })
    expect(out.counts.map((r) => [r.scope, r.label, r.department, r.open_roles])).toEqual([
      ['board', null, null, 3],
      ['department', 'Research', 'Research', 2],
      ['department', 'Solutions', 'Solutions', 1],
    ])
    expect(new Set(out.counts.map((r) => r.basis))).toEqual(new Set(['archived']))
  })

  test('a truncated capture is a skip with the reason, and no rows', () => {
    const cut = page.replace('</html>', '')
    const out = hiringRows(era, capture(era.id), cut, cut.length, FETCHED)
    expect(out.counts).toEqual([])
    expect(out.capture).toMatchObject({
      status: 'skipped',
      axis: 'hiring',
      detail: 'capture is truncated: no closing </html>',
    })
  })
})
