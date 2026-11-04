// GET /api/exposure — hyperscaler capex, backlog, and what Microsoft and Amazon
// tag on OpenAI and Anthropic, quarterly from 2020, from filed XBRL facts
// (layers/terminal/server/utils/terminal-exposure.ts). `as_of` keeps the facts
// filed before that day.

import { filedFactsStamp, queryExposure } from '../utils/terminal-exposure'
import { serveTerminalFiled, terminalDb } from '../utils/terminal-handler'
import { rateLimitTerminal } from '../utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'exposure', limit: 60, windowSeconds: 60 })
  const variant = await filedFactsStamp(terminalDb)
  return serveTerminalFiled(event, 'exposure', (ctx) => queryExposure(terminalDb, ctx), variant)
})
