// GET /api/grid-load: EIA-930 demand per balancing authority holding a lab site, and
// ERCOT's large-load counts (layers/compute/server/power/grid-query.ts). A load
// reading, not a measure of how busy any data center is.

import { gridLoadStamp, queryGridLoad } from '../power/grid-query'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'grid-load', limit: 60, windowSeconds: 60 })
  const variant = await gridLoadStamp(terminalDb)
  return serveTerminal(event, 'grid-load', () => queryGridLoad(terminalDb), { variant })
})
