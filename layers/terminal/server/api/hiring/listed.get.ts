// GET /api/hiring/listed?lab=: open roles on the job boards of the listed companies around
// the labs (neoclouds, miners turning host, chip and connectivity makers) and Google's
// data-center roles: each board's newest read, its weekly series with the change on the
// week before, its newest data-center roles, and the boards we cut with the reason. Every
// count cites the board and the read (layers/talent/server/listed-hiring/query.ts).
// `lab` keeps the boards, read and cut, of the companies /api/listed?lab= ties to that
// lab (terminal-listed-ties.ts), cut from the cached all-board payload. The query is
// talent's; the route is the shell's because the ties are.

import { listedHiringStamp, queryListedHiring } from '#layers/talent/server/listed-hiring/query'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'hiring-listed', limit: 60, windowSeconds: 60 })
  const { lab } = await getValidatedQuery(event, labQuerySchema.parse)
  const variant = await listedHiringStamp(terminalDb)
  const data = await serveTerminal(event, 'hiring-listed', () => queryListedHiring(terminalDb), {
    variant,
  })
  return lab ? listedHiringForTickers(data, await listedTickersFor(lab)) : data
})
