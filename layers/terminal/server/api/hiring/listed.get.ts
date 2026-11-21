// GET /api/hiring/listed — open roles on the job boards of the listed
// companies around the labs (neoclouds, miners turning host, chip and
// connectivity makers) and Google's data-center roles: each board's newest
// read, its weekly series with the change on the week before, its newest
// data-center roles, and the boards we cut with the reason. Every count
// cites the board and the read (layers/terminal/server/listed-hiring/query.ts).

import { listedHiringStamp, queryListedHiring } from '../../listed-hiring/query'
import { rateLimitTerminal } from '#layers/core/server/utils/api-access'
import { serveTerminal, terminalDb } from '#layers/core/server/utils/terminal-handler'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'hiring-listed', limit: 60, windowSeconds: 60 })
  const variant = await listedHiringStamp(terminalDb)
  return serveTerminal(event, 'hiring-listed', () => queryListedHiring(terminalDb), {
    variant,
  })
})
