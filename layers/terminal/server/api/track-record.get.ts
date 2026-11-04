// GET /api/track-record — for each notable or critical alert since
// 2026-09-08, when we saw the change against the first same-event press
// article (GDELT) and lab newsroom post, with the lead or lag in hours
// (layers/terminal/server/utils/terminal-track-record.ts). `as_of` returns
// what the store held at that instant: every table behind it is append-only.

import { trackRecordStamp, queryTrackRecord } from '../utils/terminal-track-record'
import { serveTerminalAsOf, terminalDb } from '../utils/terminal-handler'
import { rateLimitTerminal } from '../utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'track-record', limit: 60, windowSeconds: 60 })
  // Searches and ratings land between polls, so they key the cache too.
  const variant = await trackRecordStamp(terminalDb)
  return serveTerminalAsOf(
    event,
    'track-record',
    (ctx) => queryTrackRecord(terminalDb, ctx),
    variant,
  )
})
