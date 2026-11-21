// Demand: OpenRouter share, implied spend, GPU rental prices, and adoption.

import { recipeRunsStamp } from '../utils/terminal-db'
import { gpuRunsStamp, queryGpuPrices } from '../utils/terminal-gpu'
import { queryAdoption, VIEW_RECIPES } from '../utils/terminal-recipe-views'
import { SERIES_DAYS, SHARE_WINDOW_DAYS, queryRankings } from '../utils/terminal-rankings'
import { querySpend } from '../utils/terminal-spend'
import { json, READ_ONLY, PROVENANCE, type McpKit } from './kit'

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

  server.registerTool(
    'get_gpu_prices',
    {
      title: 'GPU rental prices',
      description:
        'On-demand H100 and B200 rental prices from first-party price pages and documented price APIs (Lambda, CoreWeave, Nebius, ' +
        'Crusoe, Together AI, DigitalOcean, Verda, Azure, Oracle, Google Cloud), normalized to usd_per_gpu_hour: an instance price divided by its GPUs, ' +
        'with gpus_per_instance, instance_usd_per_hour, region and config kept as printed. medians counts each provider once, at the ' +
        'median of its own counted rows; PCIe and NVL cards have counted=false. failed names providers whose page failed today; they are ' +
        'left out, never carried forward. history gives, per GPU, the median and the spot price as a share of on-demand (low and high bounds) ' +
        'on each date a provider’s page changed, ending on today’s read; provider_changes names each date a provider joined or left the median, which moves it with no price moving, and its method says how to read it. archived (null before the backfill) is the history from before our first ' +
        'read: the Internet Archive’s weekly copies of the same providers’ price pages (basis archived, source_id wayback:<era>), a weekly ' +
        'median per GPU, each provider’s points with the copy as source_url, and gaps with the reason; it never reaches the thesis. ' +
        '/export/archived_gpu_prices.csv has every archived row. These are list prices, not transaction prices (see caveat). The Compute thesis divides the ' +
        'flagship token price by the H100 median. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () =>
      json(
        await deps.serve(
          'gpu-prices',
          (ctx) => queryGpuPrices(deps.db, ctx),
          await gpuRunsStamp(deps.db),
        ),
      ),
  )

  server.registerTool(
    'get_adoption',
    {
      title: 'Adoption: businesses paying, package downloads, coding-agent pull requests',
      description:
        'Three reads on adoption outside the labs’ own numbers. ramp: the Ramp AI Index, the share of US businesses on Ramp that paid the vendor anything in the month by card or bill pay, ' +
        'per month (months, ascending) for overall and each vendor Ramp reports (lab ties it to a tracked lab). It measures adoption, not spend, covers Ramp’s customers only, and Ramp restates past months, ' +
        'so this is the newest release (release_seen, data_version). Google and Meta aren’t in Ramp’s vendor series. downloads: each lab’s SDK and coding-agent packages on npm and PyPI, ' +
        'last_28d against prior_28d through a date. Every download counts, CI and bots included, so read the trend, never the level, and never as users. ' +
        'agent_prs: per coding agent, daily counts of public GitHub pull requests that carry its trace (the query says which). Each agent leaves a different trace, so the counts are not shares of one market. ' +
        'caveats has the full caveat for each. Not investment advice. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () =>
      json(
        await deps.serve(
          'adoption',
          () => queryAdoption(deps.db),
          await recipeRunsStamp(deps.db, VIEW_RECIPES.adoption),
        ),
      ),
  )
}
