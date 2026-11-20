// GET /api/dependencies — the dependency graph: each company as a node sized
// by its own filed figure, each figure one company's filing puts on another
// as a line (layers/terminal/server/utils/terminal-dependencies.ts). Built
// from the exposure series and the prospectus commitments. Cached for the
// poll tick. No `as_of`: the prospectus half has no point-in-time read.

import { queryDependencies } from '../utils/terminal-dependencies'
import { serveTerminal, terminalDb } from '../utils/terminal-handler'
import { rateLimitTerminal } from '../utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'dependencies', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'dependencies', (ctx) => queryDependencies(terminalDb, ctx))
})
