// GET /api/dependencies — the dependency graph: each company as a node sized
// by its own filed figure, each figure one company's filing puts on another
// as a line (layers/companies/server/utils/terminal-dependencies.ts). Built
// from the exposure series and the prospectus commitments. Cached for the
// poll tick. No `as_of`: the prospectus half has no point-in-time read.

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'dependencies', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'dependencies', (ctx) => queryDependencies(terminalDb, ctx))
})
