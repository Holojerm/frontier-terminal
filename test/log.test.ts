// pathForLog() is what keeps query strings out of every log line: the error
// plugin writes `event.path` on every 5xx, and a query string is where a caller
// puts the things a log should never keep.

import { describe, expect, it } from 'vitest'

import { pathForLog } from '../server/utils/log'

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
