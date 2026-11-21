// GET /api/suppliers — the chip, hardware and compute-rental companies whose
// own SEC filings tie them to a lab or a cloud: one row per filed passage,
// with its figures, the quote it rests on, the document and when the quote
// was last found there (layers/companies/server/utils/terminal-suppliers.ts).
// The table is stored in D1 and grows as the suppliers' new filings are read
// (layers/companies/server/suppliers/). No `as_of`.

import { rateLimitTerminal } from '#layers/core/server/utils/api-access'
import { suppliersStamp } from '../suppliers/store'
import { serveTerminal, terminalDb } from '#layers/core/server/utils/terminal-handler'
import { querySuppliers } from '../utils/terminal-suppliers'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'suppliers', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'suppliers', () => querySuppliers(terminalDb), {
    variant: await suppliersStamp(terminalDb),
  })
})
