import { describe, expect, it } from 'vitest'

import type { RevenueProviderView } from '../shared/utils/terminal-types'
import { revenueScope } from '../app/utils/readout'

const view = (filer: Partial<NonNullable<RevenueProviderView['filer']>>, disclosure = 'parent') =>
  ({ disclosure, filer }) as unknown as RevenueProviderView

describe('revenueScope', () => {
  it('names a parent segment rather than calling it the parent', () => {
    expect(revenueScope(view({ segment_label: 'Google Cloud', ticker: 'GOOGL' }))).toBe(
      ' · Google Cloud segment',
    )
  })
  it('says a whole-parent figure is all of the parent', () => {
    expect(revenueScope(view({ segment_label: null, ticker: 'SPCX' }))).toBe(
      ' · all of SPCX, parent',
    )
  })
  it('adds nothing for the lab’s own filing', () => {
    expect(revenueScope(view({ relation: 'issuer' }, 'issuer'))).toBe('')
    expect(revenueScope(null)).toBe('')
  })
})
