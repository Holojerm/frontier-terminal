// GET /api/track-record — for each notable or critical alert since
// 2026-09-08, when we saw the change against the first same-event press
// article (GDELT) and lab newsroom post, with the lead or lag in hours
// (layers/terminal/server/utils/terminal-track-record.ts). `as_of` returns
// what the store held at that instant: every table behind it is append-only.

import { queryTrackRecord } from '../utils/terminal-track-record'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { rateLimitTerminal } from '../utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'track-record', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'track-record', (ctx) => queryTrackRecord(terminalDb, ctx), {
    asOf: 'snapshot',
  })
})
