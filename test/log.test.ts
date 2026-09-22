// pathForLog() is what keeps query strings out of every log line: the error
// plugin writes `event.path` on every 5xx, and a query string is where a caller
// puts the things a log should never keep. errorDetail() is the other half of
// that line — the part that has to say something a reader can act on.

import { describe, expect, it } from 'vitest'

import { errorDetail, pathForLog } from '../server/utils/log'

describe('pathForLog', () => {
  it('drops the query string', () => {
    expect(pathForLog('/api/pricing?provider=openai&t=signed-token')).toBe('/api/pricing')
  })

  it('drops the fragment, and a query and fragment together', () => {
    expect(pathForLog('/filings#token=abc')).toBe('/filings')
    expect(pathForLog('/filings?a=1#token=abc')).toBe('/filings')
  })

  it('leaves a bare path alone', () => {
    expect(pathForLog('/api/status')).toBe('/api/status')
    expect(pathForLog('/')).toBe('/')
  })

  it('passes undefined through so callers can spread it into JSON', () => {
    expect(pathForLog(undefined)).toBeUndefined()
    expect(pathForLog('')).toBeUndefined()
  })
})

describe('errorDetail', () => {
  it('folds the cause into the wrapper, which is the whole point', () => {
    // What server/utils/terminal-handler.ts throws when D1 is unreachable.
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
