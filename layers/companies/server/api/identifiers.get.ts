// GET /api/identifiers — the security-master registry: each company's CIK,
// LEI, ticker, MIC and FIGI with the URL and time each was read
// (layers/companies/server/utils/terminal-identifiers.ts), and the securities
// that carry each lab (terminal-entities.ts). `?entity=` narrows both to one id.

import { z } from 'zod'

const Query = z.object({
  entity: z
    .string()
    .regex(/^[a-z][a-z-]{0,39}$/)
    .optional(),
})

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'identifiers', limit: 60, windowSeconds: 60 })
  const { entity } = await getValidatedQuery(event, Query.parse)
  return serveTerminal(event, 'identifiers', async () => identifiersPayload(entity), {
    variant: entity ?? '',
  })
})
