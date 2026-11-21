// GET /api/call-guidance?ticker= — what management guided on each earnings
// call of the listed companies, from the release, the company's own
// transcript or remarks, or our transcript of its replay, each figure scored
// against the 10-Q or 10-K that later filed it
// (layers/terminal/server/utils/terminal-call-guidance.ts). Without `ticker`
// it lists the newest CALL_GUIDANCE_LIMIT statements and every company's
// coverage; with one, all of that company's. `as_of` counts what was first
// seen by then.

import { z } from 'zod'

import { CALL_TICKERS } from '../calls/curated'
import { rateLimitTerminal } from '#layers/core/server/utils/api-access'
import { callGuidanceStamp, queryCallGuidance } from '../utils/terminal-call-guidance'
import { serveTerminal, terminalDb } from '#layers/core/server/utils/terminal-handler'

const query = z.object({
  ticker: z.enum(CALL_TICKERS as [string, ...string[]]).optional(),
})

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'call-guidance', limit: 60, windowSeconds: 60 })
  const { ticker } = await getValidatedQuery(event, query.parse)
  const stamp = await callGuidanceStamp(terminalDb)
  return serveTerminal(
    event,
    'call-guidance',
    (ctx) => queryCallGuidance(terminalDb, ctx, ticker ?? null),
    { variant: ticker ? `${stamp}:${ticker}` : stamp, asOf: 'filed' },
  )
})
