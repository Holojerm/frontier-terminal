// GET /api/power-sites — the utilities, generators and equipment makers tied to each data-center site Epoch AI
// credits to a lab, and the listed companies among them. Epoch's power per site now and at its furthest estimate;
// each company with the page it was read from, the quote it rests on and when that quote was last found there.
// The companies are stored in D1 and grow as new SEC filings naming a site are read
// (layers/compute/server/power/); `gaps` names each lab site with none yet.

import { powerSitesStamp } from '../power/stamp'
import { serveTerminal, terminalDb } from '#layers/core/server/utils/terminal-handler'
import { queryPowerSites } from '../utils/terminal-datacenters'
import { rateLimitTerminal } from '#layers/core/server/utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'power-sites', limit: 60, windowSeconds: 60 })
  const variant = await powerSitesStamp(terminalDb)
  return serveTerminal(event, 'power-sites', () => queryPowerSites(terminalDb), { variant })
})
