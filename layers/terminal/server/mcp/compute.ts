// Compute around the labs: how full the data centers are, how much power each lab's sites draw, and who powers them.

import { z } from 'zod'
import { powerSitesStamp } from '../power/stamp'
import { recipeRunsStamp } from '../utils/terminal-db'
import { queryDataCenters, queryPowerSites, VIEW_RECIPES } from '../utils/terminal-recipe-views'
import { queryUtilization, SPOT_QUORUM, UTILIZATION_RECIPES } from '../utils/terminal-utilization'
import { ProviderSchema, json, READ_ONLY, PROVENANCE, type McpKit } from './kit'

export function registerComputeTools({ server, deps }: McpKit): void {
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

  server.registerTool(
    'get_datacenters',
    {
      title: 'Data-center power per lab (Epoch AI estimates)',
      description:
        'Epoch AI’s estimate of current data-center power (CC BY 4.0), from its newest snapshot. total_mw and total_h100e are every site Epoch tracks. ' +
        'labs gives, per lab, the megawatts and H100-equivalents of the sites Epoch names it as a user of at #confident or #likely, with the site names. ' +
        'A shared site counts in full for every lab that uses it (shared counts them), so the labs don’t add up to the total: never sum them. ' +
        'speculative_only lists labs Epoch names only at #speculative, a stated gap and never counted. site_list is every site, largest first, with Epoch’s owner and users verbatim. ' +
        'These are estimates (80% of power estimates fall within a factor of 1.4) and coverage starts with sites operational in 2024 or later. Cite Epoch AI beside any figure. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () =>
      json(
        await deps.serve(
          'datacenters',
          () => queryDataCenters(deps.db),
          await recipeRunsStamp(deps.db, VIEW_RECIPES.datacenters),
        ),
      ),
  )

  server.registerTool(
    'get_power_sites',
    {
      title: 'Who powers each lab’s data-center sites',
      description:
        'The utilities, generators, equipment makers and site hosts tied to each data-center site Epoch AI credits to a lab. ' +
        'sites: Epoch’s name, the labs it names as users, owner and users verbatim, mw_now (Epoch’s estimate of power now) and mw_planned with planned_date (its furthest dated estimate, when later than the snapshot). ' +
        'grid is the grid operator where a page names it. links is one company each: role (utility, generation, equipment, host), company, parent (the listed parent of a subsidiary), ticker, ' +
        'unlisted (why there is no ticker: municipal, federal, private, or not matched to a listing), mw with mw_meaning (only a figure the page itself ties to this site), quote, the sentence read from source_url, ' +
        'a filing, a regulator’s page or the company’s own, never press coverage, and basis (hand: read by a person; judge: read by a model from a new SEC filing naming the site and checked word for word). tickers rolls the links up per listed company with its roles, sites and labs, and carries no megawatts: ' +
        'a link ties a company to a site and does not say how much of the site’s power it supplies, so never sum a site’s power per company. ' +
        'uncovered lists lab sites with no power source read yet, with pending (SEC filings naming it that wait to be read); gaps names each of them and what the table never reads. The sites and their power are Epoch’s estimates (CC BY 4.0); the companies are ours. Not investment advice. ' +
        'Optional provider keeps the sites, tickers and uncovered sites tied to one lab. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const data = await deps.serve(
        'power-sites',
        () => queryPowerSites(deps.db),
        await powerSitesStamp(deps.db),
      )
      if (!provider) return json(data)
      return json({
        ...data,
        sites: data.sites.filter((s) => s.labs.includes(provider)),
        tickers: data.tickers.filter((t) => t.labs.includes(provider)),
        uncovered: data.uncovered.filter((u) => u.labs.includes(provider)),
        gaps: data.gaps.filter(
          (g) =>
            g.site === null ||
            data.uncovered.some((u) => u.name === g.site && u.labs.includes(provider)),
        ),
      })
    },
  )
}
