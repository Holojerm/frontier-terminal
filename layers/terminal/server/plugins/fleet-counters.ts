// Adds the terminal's counters to GET /api/fleet's `extra` section.

import { registerFleetExtraContributor } from '#server/utils/extensions'

import { collectTerminalCounters } from '../utils/fleet-counters'

export default defineNitroPlugin(() => {
  registerFleetExtraContributor({ key: 'terminal', collect: collectTerminalCounters })
})
