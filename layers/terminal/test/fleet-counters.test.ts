// The terminal's contribution to GET /api/fleet. Core's collectFleetCounters
// merges whatever is registered, so this is the product's half of that contract:
// every value a number, every name stable (the dashboard keys on them).

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, describe, expect, it } from 'vitest'

import * as schema from '../../../server/db/schema'
import { clearExtensionsForTest, registerFleetExtraContributor } from '../../../server/utils/extensions'
import { collectFleetCounters } from '../../../server/utils/fleet-status'
import { collectTerminalCounters } from '../server/utils/fleet-counters'

const db = drizzle(env.DB, { schema })
const NOW = new Date('2026-08-22T12:00:00.000Z')

afterEach(() => clearExtensionsForTest())

describe('collectTerminalCounters', () => {
  it('is all zeros on an empty database', async () => {
    expect(await collectTerminalCounters(db, NOW)).toEqual({
      snapshots: 0,
      entities: 0,
      changes: 0,
      alerts: 0,
      lastOkTickEdgarMs: 0,
      lastOkTickSurveyMs: 0,
      lastFailureMs: 0,
      lastTripwireRunMs: 0,
      launchStaleCells: 0,
      launchUnalerted: 0,
    })
  })

  it('lands in `extra` once registered, as numbers only', async () => {
    registerFleetExtraContributor({ key: 'terminal', collect: collectTerminalCounters })
    const { extra } = await collectFleetCounters(db, NOW)
    expect(Object.keys(extra)).toContain('lastOkTickSurveyMs')
    expect(Object.values(extra).every((value) => typeof value === 'number')).toBe(true)
  })
})
