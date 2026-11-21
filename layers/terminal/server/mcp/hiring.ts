// Open roles now and over time, and the pay the boards post.

import { z } from 'zod'
import { listedHiringStamp, queryListedHiring } from '../listed-hiring/query'
import { recipeRunsStamp } from '#layers/core/server/utils/terminal-db'
import { HIRING_WINDOW_DAYS, queryHiring, queryHiringHistory } from '../utils/terminal-hiring'
import { queryPay, VIEW_RECIPES } from '../utils/terminal-recipe-views'
import {
  ProviderSchema,
  json,
  READ_ONLY,
  AsOfSchema,
  asOfErrors,
  PROVENANCE,
  type McpKit,
} from '#layers/core/server/mcp/kit'

export function registerHiringTools({ server, deps, read }: McpKit): void {
  server.registerTool(
    'get_hiring',
    {
      title: 'Open roles',
      description:
        'Open roles per lab, counted from the CURRENT job-board set (a role missing from the board is closed), by department. ' +
        'feed says what the number is: ok, no_rows (feed registered, nothing parsed yet), or no_public_feed — Meta, DeepSeek, Alibaba and Moonshot AI, which ' +
        'have no public hiring feed we can read, so each total is 0 with the audit’s reason rather than a guess. Google counts DeepMind’s roles only ' +
        '(company_names says so), not Alphabet’s. xAI’s board is blended with SpaceX ' +
        '(every row carries company_name "SpaceXAI", now "SpaceXSI"); the caveat and company_names travel with the row so you can say so. ' +
        'as_of before our first read of the boards answers from the Internet Archive’s copies of each lab’s own board ' +
        '(source_id wayback:<era>, point_in_time names each copy; event time, not knowledge time). Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional(), as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ provider, as_of }) =>
      asOfErrors(async () => {
        const hiring = await read('hiring', as_of, (ctx) => queryHiring(deps.db, ctx), '', 'hiring')
        if (!provider) return json(hiring)
        return json({
          ...hiring,
          providers: hiring.providers.filter((p) => p.provider === provider),
        })
      }),
  )

  server.registerTool(
    'get_hiring_history',
    {
      title: 'Open roles per day',
      description:
        'Open roles per lab and department, per UTC day (dates, total, departments[].series), RECONSTRUCTED by undoing the ' +
        'change log backwards from the current job-board set — not a series of daily snapshots. Each series starts at the ' +
        'provider’s earliest board snapshot (series_from); baseline_at is this store’s first poll, and roles that opened or closed ' +
        'before the log begins are carried as they stand today, so the oldest points understate churn. compare sets today ' +
        `against ${HIRING_WINDOW_DAYS} days back, or the series start when that is younger (days says which). log is the change ` +
        'rows the series rests on. clusters[] sums named department clusters from sources.yaml — physical-infrastructure (Data Center, ' +
        'Infrastructure, Facilities, Energy, Construction, Compute, Hardware; not Software) is the capacity-buildout signal — with the ' +
        'matched department labels listed so the sum is checkable. Meta, DeepSeek, Alibaba and Moonshot AI are audited cuts (feed ' +
        'no_public_feed, reason given) with empty series; xAI carries the SpaceXAI blend caveat. archived[] is the history from ' +
        'before the live series: the Internet Archive’s weekly copies of each lab’s own board (basis archived, source_id ' +
        'wayback:<era>, at = when the Archive saw it, fetched_at = when we read it), with the board total and clusters, CC BY-NC. ' +
        'Their departments are left out here: GET /api/hiring/history has them, and /export/archived_hiring.csv every row. ' +
        'reach says how far each lab’s history goes and every gap with its reason; archive_method says the rest. ' +
        'Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional(), as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ provider, as_of }) =>
      asOfErrors(async () => {
        const history = await read(
          'hiring-history',
          as_of,
          (ctx) => queryHiringHistory(deps.db, ctx),
          '',
          'hiring',
        )
        // An archived copy's departments would put a few hundred kB in a tool
        // result; the totals and clusters stay, the rest is one request away.
        const slim = {
          ...history,
          providers: history.providers.map((p) => ({
            ...p,
            archived: p.archived.map((a) => ({ ...a, departments: null })),
          })),
        }
        if (!provider) return json(slim)
        return json({
          ...slim,
          providers: slim.providers.filter((p) => p.provider === provider),
        })
      }),
  )

  server.registerTool(
    'get_listed_hiring',
    {
      title: 'Open roles at the listed companies around the labs',
      description:
        'Open roles on the job boards of listed companies around the labs, read daily: neoclouds and miners turning host (CoreWeave, Nebius, Galaxy, Hut 8, Cipher Digital, Cerebras), chip and connectivity makers (Astera Labs, Credo), and Google’s data-center roles only. ' +
        'boards: per company (ticker), latest (the newest read: total, datacenter and infrastructure roles, source_url and fetched_at), weeks (each UTC week’s last read, with total_change and datacenter_change on the week before) and datacenter_roles (the newest data-center roles, titles verbatim). ' +
        'Each role is classed by rule from the board’s own title and department (rule says how): datacenter is data-center operations, site, construction, facilities and power; infrastructure is GPU and infrastructure engineering. ' +
        'A chipmaker’s data-center count is noise (host false): its roles sell to data centers. Google’s board has no total (scope datacenter). The hypothesis it tests: site hiring comes before megawatts and revenue; history starts 2026-11-21, so say there is not enough yet. ' +
        'cut lists the companies whose boards are not read and why (their terms, robots.txt, or no public API). Not investment advice. ' +
        PROVENANCE,
      inputSchema: z.object({
        ticker: z.string().max(8).optional().describe('Keep one company, by US ticker (CRWV).'),
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker }) => {
      const data = await deps.serve(
        'hiring-listed',
        () => queryListedHiring(deps.db),
        await listedHiringStamp(deps.db),
      )
      if (!ticker) return json(data)
      const t = ticker.toUpperCase()
      return json({ ...data, boards: data.boards.filter((b) => b.ticker === t) })
    },
  )

  server.registerTool(
    'get_pay',
    {
      title: 'Posted pay on the labs’ job boards',
      description:
        'The US annual salary bands OpenAI and Anthropic post on their job boards, reduced to each band’s midpoint. boards is one per lab, at its newest reading (date), with roles_on_board ' +
        'and cells, one per role family: median, p25 and p75 of the band midpoints in USD a year, n (the roles counted), departments (the board’s departments we mapped to the family by hand) ' +
        'and previous (the median at the reading before, when there is one). Bands are posted ranges, not offers, and leave out equity, the larger part of pay at these labs. ' +
        'Sales is left out, since Anthropic posts on-target earnings and OpenAI base pay. Compare a cell with itself over time, not one lab with another. xAI and Mistral post no usable pay. ' +
        'Optional provider keeps one lab’s board. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const data = await deps.serve(
        'pay',
        () => queryPay(deps.db),
        await recipeRunsStamp(deps.db, VIEW_RECIPES.pay),
      )
      if (!provider) return json(data)
      return json({ ...data, boards: data.boards.filter((b) => b.lab === provider) })
    },
  )
}
