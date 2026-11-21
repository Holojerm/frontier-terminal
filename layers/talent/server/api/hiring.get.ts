// GET /api/hiring — open roles per provider from the current entity set,
// by department, with the caveats that travel with the data. `as_of` counts
// the job set rebuilt at that instant; before our first read of the boards,
// each lab's newest Internet Archive copy by then (terminal-hiring-archive.ts).

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'hiring', limit: 60, windowSeconds: 60 })
  return serveTerminal(event, 'hiring', (ctx) => queryHiring(terminalDb, ctx), { asOf: 'hiring' })
})
