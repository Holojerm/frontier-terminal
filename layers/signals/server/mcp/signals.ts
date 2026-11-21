// The signal scorecard: how each registered series has related to the stocks it is expected to lead, and the forward calls.

import { querySignals, signalsStamp } from '../utils/terminal-signals'
import { json, READ_ONLY, PROVENANCE, type McpKit } from '#layers/core/server/utils/mcp-kit'

export function registerSignalTools({ server, deps }: McpKit): void {
  server.registerTool(
    'get_signals',
    {
      title: 'Signal scorecard: each series against the stocks it should lead',
      description:
        'For every series the site registers (npm and PyPI downloads, the Ramp AI Index, OpenRouter share, GPU prices, latency-probe strain, open roles, launches, price cuts, filed revenue against press reports, grid load where the lab sites are, ERCOT large loads): ' +
        'the entity it measures, the tickers it is expected to lead, and per ticker and horizon (1, 5, 20, 60 trading days) an in-sample and a held-out (newest third) statistic. ' +
        'lead_lag: the correlation between the series’ change each period and the ticker’s return less SPY’s from the first session after the figure was public. ' +
        'event: the mean of that abnormal return from the close before each event. status thin means under min_sample and carries no number: say there is not enough history. ' +
        'tests is how many results had enough sample; a p_value is uncorrected, so compare it with bonferroni_p (0.05 / tests) before calling anything significant. ' +
        'forward_calls are dated estimates of revenue, capex or remaining performance obligations, each with every method run and its inputs as they stood, never edited after it was recorded, and scored per method once a 10-Q or 10-K filed after it prints the actual (actual.in_range: inside the lowest-to-highest non-control estimate). Methods marked control use unrelated data on purpose. ' +
        'Prices behind the statistics are licensed for internal use and never served. A research exercise, not investment advice. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () =>
      json(
        await deps.serve(
          'signals',
          (ctx) => querySignals(deps.db, ctx),
          await signalsStamp(deps.db),
        ),
      ),
  )
}
