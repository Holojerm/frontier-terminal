// GET /api/disclosures?lab=: each lab's own misalignment-disclosure index (every
// report and notice in the lab's words, the dates printed on each report's page,
// and the median days between them). A lab with no index is a stated cut. `lab`
// keeps one lab's summary and entries, cut from the cached all-lab payload.

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'disclosures', limit: 60, windowSeconds: 60 })
  const { lab } = await getValidatedQuery(event, labQuerySchema.parse)
  const data = await serveTerminal(event, 'disclosures', (ctx) => queryDisclosures(terminalDb, ctx))
  return lab ? disclosuresForLab(data, lab) : data
})
