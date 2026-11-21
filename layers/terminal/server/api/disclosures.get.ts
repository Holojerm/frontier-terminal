// GET /api/disclosures?lab= — each lab's own misalignment-disclosure index:
// every report and notice in the lab's words, the discovery and publication
// dates printed on each report's page, and the median days between them.
// Every other tracked lab publishes no index and is a stated cut. `lab` keeps
// one lab's summary and entries, cut from the cached all-lab payload.

import { queryDisclosures } from '../utils/terminal-disclosures'
import { serveTerminal, terminalDb } from '#layers/core/server/utils/terminal-handler'
import { labQuerySchema } from '#layers/core/server/utils/lab-query'
import { disclosuresForLab } from '../utils/terminal-lab-cuts'
import { rateLimitTerminal } from '#layers/core/server/utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'disclosures', limit: 60, windowSeconds: 60 })
  const { lab } = await getValidatedQuery(event, labQuerySchema.parse)
  const data = await serveTerminal(event, 'disclosures', (ctx) => queryDisclosures(terminalDb, ctx))
  return lab ? disclosuresForLab(data, lab) : data
})
