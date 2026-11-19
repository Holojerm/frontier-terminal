// GET /api/ground-truth — each press report of a lab's revenue against the
// figure the lab's own filing printed later, with the error and the days
// between them, and the alert track record's totals
// (layers/terminal/server/utils/terminal-ground-truth.ts). `as_of` returns
// what the store held then: the press tables are append-only and the filed
// rows are rewound.

import { queryGroundTruth } from '../utils/terminal-ground-truth'
import { reportedStamp } from '../utils/terminal-reported'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { rateLimitTerminal } from '../utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'ground-truth', limit: 60, windowSeconds: 60 })
  // Articles and readings land between polls, so they key the cache too.
  const variant = await reportedStamp(terminalDb)
  return serveTerminal(event, 'ground-truth', (ctx) => queryGroundTruth(terminalDb, ctx), {
    variant,
    asOf: 'snapshot',
  })
})
