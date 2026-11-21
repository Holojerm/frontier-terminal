// GET /api/grid-load — EIA-930 demand for each balancing authority a lab's data-center site sits in, as monthly and weekly
// averages with the change on a year before, the sites and listed companies that place it there, and ERCOT's own count of
// the large loads it has approved to energize, one vintage per report. A load reading, not a measure of how busy any
// data center is. Every figure cites its file or report and fetch time (layers/compute/server/power/grid-query.ts).

import { gridLoadStamp, queryGridLoad } from '../power/grid-query'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'grid-load', limit: 60, windowSeconds: 60 })
  const variant = await gridLoadStamp(terminalDb)
  return serveTerminal(event, 'grid-load', () => queryGridLoad(terminalDb), { variant })
})
