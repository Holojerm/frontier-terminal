// Prose that restates a constant: the pages and the README that name every
// lab, and the strings that state the license window where no constant can be
// interpolated (publicPage summaries are read at build time, seo:check
// measures a description as its source spells it, a README is text). A tenth lab or a new window fails here, where before the page went
// on listing eight labs or 90 days.

import { describe, expect, it } from 'vitest'

import readme from '~~/README.md?raw'
import { LICENSE_SPLIT_EFFECTIVE, LICENSE_WINDOW_DAYS } from '#shared/utils/license'
import about from '../app/pages/about.vue?raw'
import license from '../app/pages/license.vue?raw'
import prices from '../../pricing/app/pages/prices/index.vue?raw'
import releases from '../../models/app/pages/releases.vue?raw'
import { LAB_DISPLAY } from '#layers/core/shared/utils/lab-names'

const labs = Object.entries(LAB_DISPLAY)
  .filter(([id]) => id !== 'other')
  .map(([, name]) => name)

/** The publicPage summary of a page, as its source spells it. */
const summaryOf = (page: string) => /summary:\s*'([^']+)'/.exec(page)?.[1] ?? ''

describe('prose that names every lab', () => {
  it.each([
    ['README.md', readme],
    ['about.vue', about],
    ['releases.vue summary', summaryOf(releases)],
    ['prices/index.vue summary', summaryOf(prices)],
  ])('%s names each tracked lab', (_, text) => {
    for (const lab of labs) expect(text, lab).toContain(lab)
  })
})

describe('prose that states the license window', () => {
  it.each([
    ['README.md', readme],
    ['license.vue summary', summaryOf(license)],
  ])('%s gives the window and the split day the code uses', (_, text) => {
    expect(text).toContain(`last ${LICENSE_WINDOW_DAYS} days`)
    expect(text).toContain(LICENSE_SPLIT_EFFECTIVE)
  })

  it('license.vue’s search description gives the window', () => {
    const description = /description:\s*'([^']+)'/.exec(license)?.[1] ?? ''
    expect(description).toContain(`last ${LICENSE_WINDOW_DAYS} days`)
  })
})
