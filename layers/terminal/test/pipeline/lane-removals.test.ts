import { describe, expect, it } from 'vitest'
import { isSetLane } from '../../server/pipeline/lane-removals'
import { LANES, laneFor } from '../../server/pipeline/lanes'

describe('isSetLane', () => {
  it('agrees with every registered lane', () => {
    for (const [id, lane] of Object.entries(LANES)) {
      expect(isSetLane(id), id).toBe(lane.removals === 'set')
    }
  })

  it.each([
    ['filing-index-0001234567-26-000001', true],
    ['openai-model-md-gpt-5', true],
    ['google-model-md-gemini-3', true],
    ['openai-misalignment-report-x', true],
    ['prospectus-revenue-abc', false],
    ['edgar-submissions-0001', false],
    ['edgar-companyfacts-0001', false],
    ['xbrl-segment-0001', false],
    ['unknown', false],
  ])('derived %s', (id, expected) => {
    expect(isSetLane(id)).toBe(expected)
    expect(laneFor(id)?.removals === 'set').toBe(expected)
  })
})
