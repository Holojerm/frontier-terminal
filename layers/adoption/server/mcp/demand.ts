// Demand: OpenRouter share and implied spend, then adoption. get_gpu_prices,
// registered between the two, is the compute layer's (server/mcp/compute.ts).

import { recipeRunsStamp } from '#layers/core/server/utils/terminal-db'
import { ADOPTION_RECIPE_IDS, queryAdoption } from '../utils/terminal-adoption'
import { SERIES_DAYS, SHARE_WINDOW_DAYS, queryRankings } from '../utils/terminal-rankings'
import { querySpend } from '../utils/terminal-spend'
import { json, READ_ONLY, PROVENANCE, type McpKit } from '#layers/core/server/mcp/kit'

export function registerDemandTools({ server, deps }: McpKit): void {
  server.registerTool(
    'get_rankings',
    {
      title: 'Demand share (OpenRouter)',
      description:
        'OpenRouter’s daily usage rankings folded into token share per lab over the newest ' +
        `${SHARE_WINDOW_DAYS} days present (shares[].share, 0..1) with the change against the ${SHARE_WINDOW_DAYS} before ` +
        '(delta_pp, percentage points; null when there is no prior window), each lab’s top models in the window, a daily ' +
        `series of the newest ${SERIES_DAYS} days, and weekly[]: every stored ISO week (Monday start, UTC), oldest first, with ` +
        'tokens and share (0..1, same denominator as shares[]) per lab and the days present (a partial week shares over those). This is OpenRouter share — one aggregator’s routed traffic, top 50 models a day plus an aggregated `other` — ' +
        'NOT market share, revenue share or total usage; say so when you cite it. Windows are days present in the store, ' +
        'not calendar days (meta.coverage names them). status is ok, not_configured (no API key on the poller, nothing fetched) ' +
        'or no_rows. The data is CC BY 4.0 and republication requires the citation carried in meta.citation, with OpenRouter’s ' +
        'own meta.as_of filled in; reproduce it beside any figure you quote. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () => json(await deps.serve('rankings', (ctx) => queryRankings(deps.db, ctx))),
  )

  server.registerTool(
    'get_spend',
    {
      title: 'Implied spend share (OpenRouter channel)',
      description:
        `The ${SHARE_WINDOW_DAYS}-day rankings joined to the vendors’ list prices: per lab, tokens routed, the share of those tokens that ` +
        'matched a priced SKU (coverage), and implied spend as a RANGE — spend_low is every token at the input list price, spend_high ' +
        'every token at the output price (the rankings carry no prompt/completion split, so a point estimate would be invented). ' +
        'share_low/share_high are each lab’s slice of the tracked labs’ implied dollars at each bound; token_share is the same window’s ' +
        'slice of the tracked labs’ tokens (NOT of all OpenRouter tokens, which get_rankings reports); priced_token_share is the lab’s slice of the priced tokens only, the same universe as the dollar shares, so compare dollars with priced_token_share. models[] shows the join per model, with reason (free, unlisted, ' +
        'unpriced) for every model excluded from dollars. This is one aggregator’s channel at list price, not revenue and not market ' +
        'share; cite it as implied OpenRouter-channel spend and reproduce the CC BY 4.0 citation in rankings.meta.citation. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () => json(await deps.serve('spend', (ctx) => querySpend(deps.db, ctx))),
  )
}

export function registerAdoptionTools({ server, deps }: McpKit): void {
  server.registerTool(
    'get_adoption',
    {
      title: 'Adoption: businesses paying, package downloads, coding-agent pull requests',
      description:
        'Three reads on adoption outside the labs’ own numbers. ramp: the Ramp AI Index, the share of US businesses on Ramp that paid the vendor anything in the month by card or bill pay, ' +
        'per month (months, ascending) for overall and each vendor Ramp reports (lab ties it to a tracked lab). It measures adoption, not spend, covers Ramp’s customers only, and Ramp restates past months, ' +
        'so this is the newest release (release_seen, data_version). Google and Meta aren’t in Ramp’s vendor series. downloads: each lab’s SDK and coding-agent packages on npm and PyPI, ' +
        'last_28d against prior_28d through a date. Every download counts, CI and bots included, so read the trend, never the level, and never as users. ' +
        'Raw counts of every growing package rise together, so two derived reads sit beside them: normalized (npm only; downloads ÷ the median of five non-AI npm packages, each against its own June 2025 mean, in controls) and share (each lab’s main SDK ÷ the tracked labs’ main SDKs on the same registry; the openai package also serves other labs’ OpenAI-compatible APIs). Each has a weekly series and a 28-day value; series names its id in the download_series export. Days npm reported as an outage (controls.outage_days) are left out of every sum. ' +
        'agent_prs: per coding agent, daily counts of public GitHub pull requests that carry its trace (the query says which). Each agent leaves a different trace, so the counts are not shares of one market. ' +
        'Both have weekly: per ISO week (Monday to Sunday, UTC; week is the Monday), oldest first, the total over the days on record (days), through the newest week whose Sunday is stored. partial is true when a day is missing, so its total covers fewer days. ' +
        'npm reaches back 540 days from our first read and PyPI 180 days, so a short series is the registry’s reach, not a young package. An agent_prs week is retrospective when any day was counted later from the PRs that still existed (deleted or private PRs missing). ' +
        'caveats has the full caveat for each. Not investment advice. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () =>
      json(
        await deps.serve(
          'adoption',
          () => queryAdoption(deps.db),
          await recipeRunsStamp(deps.db, ADOPTION_RECIPE_IDS),
        ),
      ),
  )
}
