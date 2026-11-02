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

  it('survives being handed something that is not an error at all', () => {
    expect(errorDetail('plain string')).toBe('plain string')
    expect(errorDetail(null)).toBe('null')
    expect(errorDetail(undefined)).toBe('undefined')
  })
})
