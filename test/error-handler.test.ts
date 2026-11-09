import { createError } from 'h3'
import { describe, expect, it } from 'vitest'

import { quietClientError } from '../server/error'

describe('quietClientError', () => {
  it('un-flags a fatal 404 so Nitro does not console.error it', () => {
    // What layers/terminal/app/pages/alerts/[id].vue throws for a missing id.
    const error = createError({ statusCode: 404, statusMessage: 'No such alert', fatal: true })
    quietClientError(error)
    expect(error.fatal).toBe(false)
    expect(error.statusCode).toBe(404)
    expect(error.statusMessage).toBe('No such alert')
  })

  it('un-flags a fatal 429 too', () => {
    const error = createError({ statusCode: 429, statusMessage: 'Too many requests', fatal: true })
    quietClientError(error)
    expect(error.fatal).toBe(false)
  })

  it('leaves a fatal 5xx flagged, so it still logs and still reaches Workers Issues', () => {
    const error = createError({
      statusCode: 503,
      statusMessage: 'Alert could not be read',
      fatal: true,
    })
    quietClientError(error)
    expect(error.fatal).toBe(true)
  })

  it('treats an error with no status as a 500', () => {
    const error = Object.assign(new Error('boom'), { fatal: true })
    quietClientError(error)
    expect(error.fatal).toBe(true)
  })
})
