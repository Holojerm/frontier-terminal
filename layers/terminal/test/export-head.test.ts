import { describe, expect, it } from 'vitest'

// A glob, because these tests run in workerd, which cannot read the source tree.
const files = Object.keys(import.meta.glob('../server/routes/export/**/*.ts'))

describe('/export routes answer HEAD', () => {
  // A .get.ts alone 404s on HEAD, in production and under nuxt dev alike.
  it('gives every GET route a .head.ts twin', () => {
    const gets = files.filter((file) => file.endsWith('.get.ts'))
    expect(gets.length).toBeGreaterThan(0)
    const missing = gets.filter((get) => !files.includes(get.replace(/\.get\.ts$/, '.head.ts')))
    expect(missing).toEqual([])
  })
})
