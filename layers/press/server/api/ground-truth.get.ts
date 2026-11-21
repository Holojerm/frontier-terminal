// GET /api/ground-truth — each press report of a lab's revenue against the
// figure the lab's own filing printed later, with the error and the days
// between them; press reports of a deal's size against what the other company
// filed; capex guidance from earnings releases against the year's filed
// capex; and the alert track record's totals
// (layers/press/server/utils/terminal-ground-truth.ts). `as_of` returns
// what the store held then: the press tables are append-only and the filed
// rows are rewound. `lab` scores that lab's reports alone, filtered before the
// lists are cut, so it is its own cache entry.

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'ground-truth', limit: 60, windowSeconds: 60 })
  // Articles and readings land between polls, so they key the cache too.
  const { lab } = await getValidatedQuery(event, labQuerySchema.parse)
  const stamp = await reportedStamp(terminalDb)
  return serveTerminal(event, 'ground-truth', (ctx) => queryGroundTruth(terminalDb, ctx, lab), {
    // The all-lab entry keys on the stamp alone.
    variant: lab ? `${stamp}:${lab}` : stamp,
    asOf: 'snapshot',
  })
})
