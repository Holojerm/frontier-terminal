// get_utilization: the compute layer's utilization reads beside CoreWeave's
// revenue and OpenRouter's demand shape (terminal-utilization-query.ts), so it
// stays in the shell with that query. Registered just before the compute tools.

import { recipeRunsStamp } from '#layers/core/server/utils/terminal-db'
import { SPOT_QUORUM } from '#layers/compute/server/utils/terminal-utilization'
import { queryUtilization, UTILIZATION_RECIPES } from '../utils/terminal-utilization-query'
import { json, READ_ONLY, PROVENANCE, type McpKit } from '#layers/core/server/mcp/kit'

export function registerUtilizationTools({ server, deps }: McpKit): void {
  server.registerTool(
    'get_utilization',
    {
      title: 'Data-center utilization, as far as public sources say',
      description:
        'Four readings on how full the data centers are, each from free public sources and none of them a measured utilization rate. ' +
        'spot: per GPU rental provider, the spot price against the on-demand price for the same instance on the same page (ratio, 0 to 1, as low and high bounds; ' +
        `near 1 means little spare capacity is on offer). combined is null for a GPU until ${SPOT_QUORUM} providers print a spot price for it. ` +
        'implied: Alphabet’s stated tokens per minute (the release’s sentence, verbatim) divided by the newest MLPerf Inference round’s results per H100-equivalent (benchmark.round names it), as a share of Epoch AI’s estimate of Google’s fleet. ' +
        'Every share is a pair of bounds and the site never prints a midpoint, so never quote one; it assumes one model served every token, which never holds. ' +
        'benchmark_rounds: every stored MLPerf Inference round side by side, per accelerator and benchmark at the same accelerator count, each round’s fastest result in tokens per second per accelerator (our division) with its result ID, and change, the newest over the round before. ' +
        'Quote a figure only with its round, its result ID, the word unverified and the footnote (Result not verified by MLCommons Association). ' +
        'coreweave: CoreWeave’s quarterly revenue per megawatt of active power, from its filings, and floor, the newest quarter’s revenue as a share of what that power would bill at its list prices today ' +
        '(the gap to 100% is contract discount plus idle capacity, which filings don’t separate). demand_shape: OpenRouter’s average day against its busiest in the window, ' +
        'one aggregator’s traffic. Each section has its method and caveat: read them before quoting a number. A section is null until its sources have been read. Not investment advice. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () =>
      json(
        await deps.serve(
          'utilization',
          (ctx) => queryUtilization(deps.db, ctx),
          await recipeRunsStamp(deps.db, UTILIZATION_RECIPES),
        ),
      ),
  )
}
