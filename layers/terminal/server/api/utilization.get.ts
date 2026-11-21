// GET /api/utilization — how full the data centers are, as far as free public sources say: spot against on-demand GPU prices per provider,
// Alphabet's stated token volume as a share of Google's estimated fleet (a pair of bounds per benchmark model), CoreWeave's revenue per
// megawatt of active power, and OpenRouter's average day against its busiest. Read from the thesis recipes
// (layers/terminal/server/utils/terminal-utilization-query.ts); every figure cites its source and fetch time.

import { recipeRunsStamp } from '#layers/core/server/utils/terminal-db'
import { serveTerminal, terminalDb } from '#layers/core/server/utils/terminal-handler'
import {
  queryUtilization,
  UTILIZATION_RECIPES,
} from '#layers/terminal/server/utils/terminal-utilization-query'
import { rateLimitTerminal } from '#layers/core/server/utils/api-access'

export default defineEventHandler(async (event) => {
  await rateLimitTerminal(event, { name: 'utilization', limit: 60, windowSeconds: 60 })
  const variant = await recipeRunsStamp(terminalDb, UTILIZATION_RECIPES)
  return serveTerminal(event, 'utilization', (ctx) => queryUtilization(terminalDb, ctx), {
    variant,
  })
})
