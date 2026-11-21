import { describe, expect, it } from 'vitest'

import type { DataCentersData } from '#layers/compute/shared/utils/compute-views'
import type { RevenueProviderView } from '../shared/utils/terminal-types'
import { READOUT_AXES, READOUT_GROUPS, powerCell, revenueScope } from '../app/utils/readout'

describe('READOUT_GROUPS', () => {
  it('puts every axis in one group, in the strip’s order', () => {
    expect(READOUT_GROUPS.flatMap((g) => [...g.axes])).toEqual([...READOUT_AXES])
  })
})

describe('powerCell', () => {
  const source = {
    recipe_id: 'epoch-data-centers',
    label: 'Epoch AI',
    source_url: 'https://epoch.ai/data/data-centers',
    fetched_at: '2026-11-19T06:00:00.000Z',
  }
  const site = (lab: string, mw: number, sites: number) =>
    ({ lab, mw, h100e: 0, sites, shared: 0, names: [] }) as DataCentersData['labs'][number]
  const data = (labs: DataCentersData['labs'], speculative: string[] = []) => ({
    labs,
    speculative_only: speculative as DataCentersData['speculative_only'],
    source,
  })

  it('prints megawatts with the site count and Epoch’s citation', () => {
    const c = powerCell('openai', 'OpenAI', data([site('openai', 1234.6, 3)]))
    expect(c.value).toBe('1,235 MW')
    expect(c.sub).toBe('3 sites · Epoch AI estimate')
    expect(c.source).toBe(source)
    expect(c.to).toBe('/labs/openai#power')
    expect(c.gap).toBeNull()
  })
  it('states a gap for sites that draw no power yet instead of a zero', () => {
    const c = powerCell('xai', 'xAI', data([site('xai', 0, 1)]))
    expect(c.value).toBeNull()
    expect(c.gap?.title).toBe('No power yet')
    expect(c.gap?.reason).toContain('xAI’s site.')
  })
  it('tells a lab named only as speculative from one not named at all', () => {
    expect(powerCell('mistral', 'Mistral', data([], ['mistral'])).gap?.title).toBe(
      'No site counted',
    )
    expect(powerCell('mistral', 'Mistral', data([])).gap?.title).toBe('No site named')
  })
  it('says the data is missing when the request failed', () => {
    expect(powerCell('openai', 'OpenAI', null).gap?.title).toBe('No power data yet')
  })
})

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
