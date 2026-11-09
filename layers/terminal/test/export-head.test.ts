import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const EXPORT_ROUTES = resolve(import.meta.dirname, '../server/routes/export')

describe('/export routes answer HEAD', () => {
  // A .get.ts alone 404s on HEAD, in production and under nuxt dev alike.
  it('gives every GET route a .head.ts twin', () => {
    const files = readdirSync(EXPORT_ROUTES, { recursive: true, encoding: 'utf8' })
    const gets = files.filter((file) => file.endsWith('.get.ts'))
    expect(gets.length).toBeGreaterThan(0)
    const missing = gets.filter((get) => !files.includes(get.replace(/\.get\.ts$/, '.head.ts')))
    expect(missing).toEqual([])
  })
})
