// GET /api/identifiers — the security-master registry: each company's CIK,
// LEI, ticker, MIC and FIGI with the URL and time each was read
// (layers/terminal/server/utils/terminal-identifiers.ts), and the securities
// that carry each lab (terminal-entities.ts). `?entity=` narrows both to one id.

import { z } from 'zod'

import { rateLimitTerminal } from '../utils/api-access'
import { serveTerminal } from '../utils/terminal-handler'
import { identifiersPayload } from '../utils/terminal-identifiers'

const Query = z.object({
  entity: z
    .string()
    .regex(/^[a-z][a-z-]{0,39}$/)
    .optional(),
})

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'identifiers', limit: 60, windowSeconds: 60 })
  const { entity } = await getValidatedQuery(event, Query.parse)
  return serveTerminal(event, 'identifiers', async () => identifiersPayload(entity), entity ?? '')
})
