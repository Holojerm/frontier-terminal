// GET /api/signals — the signal scorecard: every registered series with its
// lead-lag and event-study statistics against the tickers it is expected to
// lead, and the forward calls (layers/signals/server/utils/terminal-signals.ts).
// Statistics only: the prices behind them are licensed for internal use and
// never served. `as_of` is refused, since the statistics are recomputed whole
// each day.

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'signals', limit: 60, windowSeconds: 60 })
  const variant = await signalsStamp(terminalDb)
  return serveTerminal(event, 'signals', (ctx) => querySignals(terminalDb, ctx), { variant })
})
