// Compute around the labs: how much power each lab's sites draw, who powers them, the grid
// load where they sit and the hardware prints. get_utilization is the shell's (server/mcp/utilization.ts
// in the terminal layer).

import { z } from 'zod'
import { gridLoadStamp, queryGridLoad } from '../power/grid-query'
import { powerSitesStamp } from '../power/stamp'
import { printsStamp } from '../prints/store'
import { queryPrints } from '../utils/terminal-prints'
import { recipeRunsStamp } from '#layers/core/server/utils/terminal-db'
import {
  DATACENTER_RECIPES,
  queryDataCenters,
  queryPowerSites,
} from '../utils/terminal-datacenters'
import {
  ProviderSchema,
  json,
  READ_ONLY,
  PROVENANCE,
  type McpKit,
} from '#layers/core/server/mcp/kit'

export function registerComputeTools({ server, deps }: McpKit): void {
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
          await recipeRunsStamp(deps.db, DATACENTER_RECIPES.datacenters),
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

  server.registerTool(
    'get_grid_load',
    {
      title: 'Grid load where the lab sites are (EIA-930, ERCOT)',
      description:
        'Demand on each balancing authority that holds a data-center site Epoch AI credits to a lab, from the U.S. Energy Information Administration’s EIA-930 hourly data (adjusted demand, public domain). ' +
        'areas: per authority (ba is EIA’s code: ERCO, PJM, MISO, NYIS, AZPS), sites placed in it with basis (grid: a page names the site’s grid operator, quote and source_url are that page’s; utility: a page ties the site to a utility and EIA-861 puts the utility in this authority, quote is EIA-861’s row), ' +
        'tickers (the listed companies tied to those sites in get_power_sites, with their roles), monthly (average MW over each whole month and yoy, the change on the same month a year before), weekly (the newest two years of whole Monday-to-Sunday weeks, yoy against 52 weeks before) and latest. ' +
        'This is a load reading, never a utilization rate: an authority’s demand moves with weather, the economy and every other customer, and nothing here separates the sites’ share, so never call it data-center utilization. ' +
        'ercot: ERCOT’s own large-load figures from its monthly PDFs, one vintage per report. months has, per month, approved_mw (approved to energize) and observed_peak_mw (the sum of each approved load’s own monthly peak, not their combined draw) from the newest report stating it, and vintages (how many reports state it). ' +
        'queue is the large-load interconnection queue where a report states its size, with qualifier (more than, roughly) and horizon; energized the all-time observed energized total. Quote each figure with its sentence. ' +
        'unplaced lists lab sites no page places in an authority; gaps says what is not read. Not investment advice. ' +
        PROVENANCE,
      annotations: READ_ONLY,
    },
    async () =>
      json(
        await deps.serve('grid-load', () => queryGridLoad(deps.db), await gridLoadStamp(deps.db)),
      ),
  )

  server.registerTool(
    'get_hardware_prints',
    {
      title: 'Monthly hardware prints: Taiwan revenue and Korea chip exports, point in time',
      description:
        'The monthly revenue of TSMC (2330.TW, TSM), Hon Hai (2317.TW), Quanta (2382.TW), Wistron (3231.TW), Wiwynn (6669.TW), Gigabyte (2376.TW), Accton (2345.TW) and Delta (2308.TW), in TWD, and Korea’s semiconductor exports (entity kr-semiconductors) in USD for the first 10 days (window d10), the first 20 days (d20) and the whole month, from Korea Customs Service releases under KOGL Type 1, and Korea’s HS 8542 (integrated circuits) exports since 2013 from UN Comtrade (series kr_hs8542_exports, same entity; cite "Source: UN Comtrade."). ' +
        'series has one entry per company or country series: entity (with leads, the basket tickers the series is meant to lead, and layer), series (the series id), points newest month first, revisions (how many stored rows revise a month already held) and ties. ' +
        'A point is the month’s newest figure from its finest source, first_value the first figure that source gave where it later changed, yoy_pct as the release states it (null for kr_hs8542_exports, which states none), ' +
        'first_seen_at (when our read first held it; for history read after the fact, the read, not the release) and published_at (the release time where the source states one: TSMC’s 6-K EDGAR acceptance, a KCS release’s embargo time, a Comtrade dataset’s lastReleased). ' +
        'Each tie is a quote from a filing, an annual report or a company statement naming who the company builds for or supplies (NVIDIA, AMD, OpenAI, Meta), with its URL. ' +
        'gaps says what is not covered, including history before our first read for six of the eight Taiwan companies and Korea Customs Service’s figures for January to September 2026. Every vintage is in the hardware_prints export. Not investment advice. ' +
        'Optional entity keeps one company. ' +
        PROVENANCE,
      inputSchema: z.object({ entity: z.string().optional() }),
      annotations: READ_ONLY,
    },
    async ({ entity }) => {
      const data = await deps.serve(
        'prints',
        (ctx) => queryPrints(deps.db, ctx),
        await printsStamp(deps.db),
      )
      if (!entity) return json(data)
      return json({ ...data, series: data.series.filter((s) => s.entity.id === entity) })
    },
  )
}
