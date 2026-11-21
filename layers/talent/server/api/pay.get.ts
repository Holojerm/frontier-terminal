// GET /api/pay — Posted US salary bands on OpenAI's and Anthropic's job boards, as median band midpoints per role family. Read from the thesis recipes
// (layers/talent/server/utils/terminal-pay.ts); every figure cites its source and fetch time.

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'pay', limit: 60, windowSeconds: 60 })
  const variant = await recipeRunsStamp(terminalDb, PAY_RECIPE_IDS)
  return serveTerminal(event, 'pay', () => queryPay(terminalDb), { variant })
})
