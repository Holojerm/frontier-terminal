// A D1 failure inside a route's query answers 503, not a bare 500 (#182).

import { describe, expect, it } from 'vitest'

import { asDatabaseFault, isD1Fault, withDatabaseFault } from '../server/utils/d1-fault'
import { errorDetail } from '../server/utils/error-detail'

const failedQuery = (ids: number) =>
  Object.assign(
    new Error(
      `Failed query: select "id" from "changes" where "id" in (${'?, '.repeat(ids - 1)}?)\nparams: ${'x,'.repeat(ids)}`,
    ),
    { cause: new Error('D1_ERROR: string or blob too big: SQLITE_TOOBIG') },
  )

describe('d1 fault mapping', () => {
  it('recognises a failed query and a D1 error, and nothing else', () => {
    expect(isD1Fault(failedQuery(3))).toBe(true)
    expect(isD1Fault(new Error('D1_ERROR: Network connection lost'))).toBe(true)
    expect(isD1Fault(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isD1Fault(Object.assign(new Error('Failed query: x'), { statusCode: 400 }))).toBe(false)
  })

  it('throws a 503 whose cause survives the 500-character spool', async () => {
    const thrown = await withDatabaseFault(async () => {
      throw failedQuery(95)
    })().catch((e: unknown) => e)
    expect(thrown).toMatchObject({ statusCode: 503, message: 'Database unavailable' })
    const detail = `503 ${errorDetail(thrown)}`
    expect(detail.length).toBeLessThan(500)
    expect(detail).toContain('SQLITE_TOOBIG')
  })

  it('passes other errors and results through unchanged', async () => {
    const bug = new TypeError('x is undefined')
    expect(asDatabaseFault(bug)).toBe(bug)
    await expect(withDatabaseFault(async (n: number) => n + 1)(1)).resolves.toBe(2)
  })
})
