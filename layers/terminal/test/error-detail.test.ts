// errorDetail() is what makes the ops digest say why the database failed, not just that it did.

import { describe, expect, it } from 'vitest'

import { errorDetail } from '../server/utils/error-detail'

describe('errorDetail', () => {
  it('folds the cause into the wrapper, which is the whole point', () => {
    // What layers/terminal/server/utils/terminal-handler.ts throws when D1 is unreachable.
    const wrapped = Object.assign(new Error('Database unavailable'), {
      cause: new Error('D1_ERROR: network connection lost'),
    })
    expect(errorDetail(wrapped)).toBe('Database unavailable: D1_ERROR: network connection lost')
  })

  it('returns the message alone when nothing was wrapped', () => {
    expect(errorDetail(new Error('No such alert'))).toBe('No such alert')
    expect(errorDetail(Object.assign(new Error('boom'), { cause: null }))).toBe('boom')
  })

  it('does not repeat itself when the cause carries the same message', () => {
    const same = Object.assign(new Error('boom'), { cause: new Error('boom') })
    expect(errorDetail(same)).toBe('boom')
  })

  it('stringifies a cause that is not an Error', () => {
    const thrown = Object.assign(new Error('Database unavailable'), { cause: 'SQLITE_BUSY' })
    expect(errorDetail(thrown)).toBe('Database unavailable: SQLITE_BUSY')
  })

  // DrizzleQueryError's shape (drizzle-orm/errors.js): the statement and params, the D1 error as cause.
  const failedQuery = (ids: number) =>
    Object.assign(
      new Error(
        `Failed query: select "id", "before_json" from "changes" where "changes"."id" in (${Array(ids).fill('?').join(', ')})\nparams: ${Array(ids).fill('a'.repeat(64)).join(',')}`,
      ),
      { cause: new Error('D1_ERROR: string or blob too big: SQLITE_TOOBIG') },
    )

  it('puts a failed query’s D1 error first, so the 500-character spool keeps it (#182)', () => {
    // As Nitro hands it to the error plugin: an H3Error carrying the query error's message.
    const query = failedQuery(95)
    const thrown = Object.assign(new Error(query.message), { cause: query })
    const detail = errorDetail(thrown)
    expect(detail).toBe(
      'D1_ERROR: string or blob too big: SQLITE_TOOBIG (in: select "id", "before_json" from "changes" where "changes"."id" in (?×95))',
    )
    expect(detail.length).toBeLessThan(500)
  })

  it('keeps the wrapper when one is there, and says so when the query error has no cause', () => {
    const wrapped = Object.assign(new Error('Database unavailable'), { cause: failedQuery(3) })
    expect(errorDetail(wrapped)).toBe(
      'Database unavailable: D1_ERROR: string or blob too big: SQLITE_TOOBIG (in: select "id", "before_json" from "changes" where "changes"."id" in (?×3))',
    )
    const bare = new Error('Failed query: select 1 where x = ?\nparams: 1')
    expect(errorDetail(bare)).toBe('query failed (in: select 1 where x = ?)')
  })

  it('survives being handed something that is not an error at all', () => {
    expect(errorDetail('plain string')).toBe('plain string')
    expect(errorDetail(null)).toBe('null')
    expect(errorDetail(undefined)).toBe('undefined')
  })
})
