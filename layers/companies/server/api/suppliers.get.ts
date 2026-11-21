// GET /api/suppliers: chip, hardware and compute-rental companies whose own SEC filings tie
// them to a lab or a cloud, one row per filed passage with its figures, quote, document and
// when the quote was last found (layers/companies/server/utils/terminal-suppliers.ts).
// Stored in D1, growing as new filings are read (layers/companies/server/suppliers/). No
// `as_of`.

import { suppliersStamp } from '../suppliers/store'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'suppliers', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'suppliers', () => querySuppliers(terminalDb), {
    variant: await suppliersStamp(terminalDb),
  })
})
