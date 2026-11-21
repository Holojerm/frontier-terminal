// GET /api/power-sites: the companies tied to each lab site Epoch AI credits, each
// with its source page, quote and last check, growing as new SEC filings are read
// (layers/compute/server/power/); `gaps` names each lab site with none yet.

import { powerSitesStamp } from '../power/stamp'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'power-sites', limit: 60, windowSeconds: 60 })
  const variant = await powerSitesStamp(terminalDb)
  return serveTerminal(event, 'power-sites', () => queryPowerSites(terminalDb), { variant })
})
