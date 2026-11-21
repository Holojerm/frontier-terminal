// Adds the terminal's counters to GET /api/fleet's `extra` section.

export default defineNitroPlugin(() => {
  registerFleetExtraContributor({ key: 'terminal', collect: collectTerminalCounters })
})
