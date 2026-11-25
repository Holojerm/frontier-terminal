// GET /api/call-guidance?ticker=&lab=: what management guided on each listed company's
// earnings call (from the release, the company's transcript or remarks, or our transcript
// of its replay), each figure scored against the 10-Q or 10-K that later filed it
// (layers/companies/server/utils/terminal-call-guidance.ts). Without either, the newest
// CALL_GUIDANCE_LIMIT statements and every company's coverage; with `ticker`, all of that
// company's; with `lab`, all of the call companies /api/listed?lab= ties to that lab
// (terminal-listed-ties.ts), with the tally over them. `as_of` counts what was first seen
// by then. The query is companies'; the route is the shell's because the ties are.

import { z } from 'zod'

import { CALL_COMPANIES, CALL_TICKERS } from '#layers/companies/server/calls/curated'

const query = labQuerySchema
  .extend({ ticker: z.enum(CALL_TICKERS as [string, ...string[]]).optional() })
  .refine((q) => !(q.ticker && q.lab), { message: 'Pass ticker or lab, not both.' })

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'call-guidance', limit: 60, windowSeconds: 60 })
  const { ticker, lab } = await getValidatedQuery(event, query.parse)
  const stamp = await callGuidanceStamp(terminalDb)
  const tickers = lab ? (await listedTickersFor(lab)).filter((t) => CALL_COMPANIES.has(t)) : []
  const scope: CallScope = lab ? { lab, tickers } : ticker ? { ticker } : null
  // The tie set is in the key: a lab's companies can change within one poll tick.
  const variant = lab
    ? `${stamp}:lab=${lab}:${tickers.join(',')}`
    : ticker
      ? `${stamp}:${ticker}`
      : stamp
  return serveTerminal(event, 'call-guidance', (ctx) => queryCallGuidance(terminalDb, ctx, scope), {
    variant,
    asOf: 'filed',
  })
})
