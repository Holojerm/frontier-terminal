// GET /api/gpu-prices — on-demand GPU rental prices per provider, normalized
// to USD per GPU-hour, with the equal-weight H100 and B200 medians the
// Compute thesis reads. Every row cites its provider page and fetch time.

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'gpu-prices', limit: 60, windowSeconds: 60 })
  const variant = await gpuRunsStamp(terminalDb)
  return serveTerminal(event, 'gpu-prices', (ctx) => queryGpuPrices(terminalDb, ctx), { variant })
})
