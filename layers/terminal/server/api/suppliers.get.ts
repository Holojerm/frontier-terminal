// GET /api/suppliers — the chip, hardware and compute-rental companies whose
// own SEC filings tie them to a lab or a cloud: one row per filed passage,
// with its figures, the quote it rests on, the document and when the quote
// was last found there (layers/terminal/server/utils/terminal-suppliers.ts).
// The table is read by hand and ships with the build. No `as_of`.

import { rateLimitTerminal } from '../utils/api-access'
import { serveTerminal } from '../utils/terminal-handler'
import { buildSuppliers, SUPPLIERS_VERSION } from '../utils/terminal-suppliers'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'suppliers', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'suppliers', async () => buildSuppliers(), {
    variant: SUPPLIERS_VERSION,
  })
})
