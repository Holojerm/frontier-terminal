// What the filings say: call guidance, revenue and registration filings. The press
// reports scored against them (get_reported, get_ground_truth), registered right after,
// are the press layer's (layers/press/server/mcp/press.ts).

import { z } from 'zod'
import { queryProspectus } from '../utils/terminal-prospectus'
import { queryRevenue } from '../utils/terminal-revenue'
import { CALL_TICKERS } from '../calls/curated'
import { callGuidanceStamp, queryCallGuidance } from '../utils/terminal-call-guidance'
import {
  ProviderSchema,
  json,
  READ_ONLY,
  AsOfSchema,
  asOfErrors,
  PROVENANCE,
  type McpKit,
} from '#layers/core/server/mcp/kit'

export function registerFilingTools({ server, deps, read }: McpKit): void {
  server.registerTool(
    'get_call_guidance',
    {
      title: 'Earnings-call guidance, scored against later filings',
      description:
        'What management of the 45 listed companies around the labs guided on each earnings call (capex, revenue, a segment or AI line, gross margin, backlog), ' +
        'read from the earnings 8-K/6-K exhibits, the transcript or prepared remarks the company posts, or our machine transcript of the replay (AssemblyAI; marked source audio). ' +
        'Each statement has metric, period, low/high in unit (USD, percent, growth_yoy, growth_qoq), bound, a quote of at most 25 words, the speaker and the time into the replay where known, and its sources. ' +
        'state is met, above or below once a later 10-Q or 10-K filed the same measure and period (actual, with the filing, and error_share: actual less the guided midpoint over the midpoint), ' +
        'open until then, or unscored with the reason (a segment line, an AI figure, a non-GAAP margin, a foreign filer). companies lists what each company posts and why some calls can’t be read. ' +
        'Without ticker it returns the newest 60 statements and every company’s coverage. Not investment advice. ' +
        PROVENANCE,
      inputSchema: z.object({
        ticker: z.enum(CALL_TICKERS as [string, ...string[]]).optional(),
        as_of: AsOfSchema,
      }),
      annotations: READ_ONLY,
    },
    ({ ticker, as_of }) =>
      asOfErrors(async () =>
        json(
          await read(
            'call-guidance',
            as_of,
            (ctx) => queryCallGuidance(deps.db, ctx, ticker ?? null),
            `${await callGuidanceStamp(deps.db)}${ticker ? `:${ticker}` : ''}`,
            'filed',
          ),
        ),
      ),
  )

  server.registerTool(
    'get_revenue',
    {
      title: 'Disclosed revenue (primary source only)',
      description:
        'Revenue each lab, or the public parent that consolidates it, has reported to the SEC, read from EDGAR’s XBRL data. ' +
        'disclosure is none (no audited disclosure on file — nothing is shown, and press run-rates are deliberately absent), parent ' +
        '(a public parent’s figure, labelled as the parent’s: xAI via SpaceX/SPCX consolidated, whose XBRL carries no xAI segment; Google via Alphabet/GOOGL’s Google Cloud segment, filer.segment set, which is the segment’s revenue, not Gemini’s; Alibaba shows none: its parent reports in RMB and only annually in XBRL), ' +
        'issuer (the lab files for itself — tagged in sources.yaml, or resolved at poll time from its own S-1 by the pending_filers patterns, ' +
        'in which case filer.tagged_by is resolved and filer.resolved_from names the filing) or no_rows (tagged, nothing parsed yet). periods are the filer’s own USD values per ' +
        '(start, end) from the newest filing that reported them, each with the tag, form, accession and a link to the filing index; ' +
        'days distinguishes a quarter (~91) from a half (~182) or a year (~365) — nothing is derived across periods. superseded lists ' +
        'values a later filing restated. Never call a parent’s number the lab’s. Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional(), as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ provider, as_of }) =>
      asOfErrors(async () => {
        const revenue = await read('revenue', as_of, (ctx) => queryRevenue(deps.db, ctx))
        if (!provider) return json(revenue)
        return json({
          ...revenue,
          providers: revenue.providers.filter((p) => p.provider === provider),
        })
      }),
  )

  server.registerTool(
    'get_prospectus',
    {
      title: 'What a lab’s own S-1 prints beyond revenue',
      description:
        'For each lab that has filed its own registration statement (today Anthropic’s S-1 and S-1/A), what the document prints, read as printed: ' +
        'statement.periods and statement.lines are the whole statement of operations — every line verbatim with a canonical key where known ' +
        '(revenue, total_operating_expenses, operating_income, net_income, eps_basic_diluted, weighted_shares_basic_diluted) — in dollars, shares or dollars per share, ' +
        'each period from the newest filing that reports it (statement.superseded keeps the earlier filing’s figures); interim periods are unaudited. ' +
        'statement.not_printed names lines an analyst may look for that the statement does not print (Anthropic prints no cost of revenue or gross profit, ' +
        'so there is no gross margin — do not derive one). commitments are the contractual-obligation and purchase-commitment schedules with their as-of date ' +
        'and year buckets; approximate marks a figure the filing itself calls approximate, and statement quotes the sentence. concentration lists customers ' +
        'at or above 10% of revenue or receivables, named as the filing names them; a null share is under 10%, not zero. shares are “The Offering” counts, null ' +
        'while the filing leaves them blank. risk_factors.latest is every heading in the newest filing; risk_factors.diffs is each amendment against the filing ' +
        'before it — added, removed, or reworded with the earlier words. Nothing is estimated. Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const data = await deps.serve('prospectus', (ctx) => queryProspectus(deps.db, ctx))
      if (!provider) return json(data)
      return json({ ...data, issuers: data.issuers.filter((i) => i.provider === provider) })
    },
  )
}
