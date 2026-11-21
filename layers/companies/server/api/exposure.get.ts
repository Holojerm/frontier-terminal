// GET /api/exposure — hyperscaler capex, backlog, and what Microsoft and Amazon
// tag on OpenAI and Anthropic, quarterly from 2020, from filed XBRL facts
// (layers/companies/server/utils/terminal-exposure.ts). `as_of` keeps the facts
// filed before that day.

import { queryExposure } from '../utils/terminal-exposure'
import { serveTerminal, terminalDb } from '#layers/core/server/utils/terminal-handler'
import { rateLimitTerminal } from '#layers/core/server/utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'exposure', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'exposure', (ctx) => queryExposure(terminalDb, ctx), {
    asOf: 'filed',
  })
})
