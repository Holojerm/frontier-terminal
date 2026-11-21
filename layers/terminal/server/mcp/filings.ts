// What the filings say: revenue, registration filings, and press reports scored against them.

import { z } from 'zod'
import { queryProspectus } from '../utils/terminal-prospectus'
import { queryRevenue } from '../utils/terminal-revenue'
import { queryGroundTruth } from '../utils/terminal-ground-truth'
import { queryReported, reportedStamp } from '../utils/terminal-reported'
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

  server.registerTool(
    'get_reported',
    {
      title: 'Press-reported revenue, valuations and funding (unaudited)',
      description:
        'What press headlines say about each private lab’s revenue, revenue run-rate, valuation and funding: never a filing, and never mixed with get_revenue. ' +
        'Headlines come from GDELT’s files. Our judge model labels each figure a headline states, and a label is kept only when its amount and lab are in the headline as written. ' +
        'recent is every figure, newest first: lab, metric (revenue_run_rate, annualized or recurring; revenue, for a stated period; valuation; funding, one round; funding_total, raised to date), ' +
        'basis (reported, given as fact; sought, in talks or planned; projected, a forecast or target), ' +
        'currency, amount with amount_text as the headline writes it, period when the headline names one (else the figure is as of the report), title, outlet, url (the earliest copy), published_at ' +
        '(when GDELT first read it, not when the outlet published) and outlets (how many ran the same headline). series is per lab, metric and currency, basis reported only: latest, and per quarter ' +
        'of reporting the median, low, high and number of distinct headlines. coverage says where the read starts, how many GDELT files are read and waiting, and how many headlines the judge hasn’t read. ' +
        'A headline is one outlet’s claim, often citing unnamed sources; GDELT misses Bloomberg, Reuters, the WSJ and the FT. get_ground_truth scores these figures against the filings that came later. ' +
        'Not investment advice. Optional provider keeps one lab. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional(), as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ provider, as_of }) =>
      asOfErrors(async () => {
        const data = await read(
          'reported',
          as_of,
          (ctx) => queryReported(deps.db, ctx),
          await reportedStamp(deps.db),
        )
        if (!provider) return json(data)
        return json({
          ...data,
          series: data.series.filter((s) => s.lab === provider),
          recent: data.recent.filter((r) => r.lab === provider),
        })
      }),
  )

  server.registerTool(
    'get_ground_truth',
    {
      title: 'Ground truth: press reports and capex guidance against the filing that came later',
      description:
        'For a lab that files for itself (Anthropic so far): each press headline that stated its revenue before a filing printed that figure, ' +
        'grouped under the filed figure. resolutions[] has the filed value, the first filing that printed it (first_filed, form, filing_url), ' +
        'the reports scored against it earliest first, the median report, error_pct ((reported − filed) / filed), and lead_days from the earliest report to the filing day. ' +
        'A report is scored only against a figure not yet filed when it was published. matched_by says how the period was chosen: stated (the headline names the year or quarter) ' +
        'or nearest (the closest not-yet-filed figure within tolerance_pct, since most headlines name no year). ' +
        'A filed figure with derived_from is one filed period minus another with the same start (a quarter no filing prints). ' +
        'States: matched, missed (a named period more than tolerance_pct off), restated (published on or after the filing day, not scored), open (nothing filed to check it against). ' +
        'held_before_filing is false for a headline we read back from GDELT’s archive after the filing: the press had it first and our store did not. ' +
        'waiting[] lists reported figures no filing can score: a lab that hasn’t filed (no-filing), or run-rates, valuations and funding (not-in-filings). ' +
        'deals.reports[] checks press reports of a deal’s size (metric commitment, investment, financing or commitment_total, with the counterparty as the headline names it) ' +
        'against the figure the other company filed. deals.measures[] lists each filed figure used and how: added (the amount added to a backlog in the quarter the report was published), ' +
        'total (the first balance dated on or after the report), or null with why (a backlog balance isn’t a contract’s headline value). ' +
        'A deal report is unsettled, with reason and why, when we read no filings from the counterparty (no-filer), its filings state no figure for it (not-filed), or they state a different measure (different-measure). Unsettled reports are never scored. ' +
        'guidance.rows[] has each capex figure an earnings release (8-K exhibit 99.1) printed for a fiscal year: low and high in USD, the release’s sentence, and actual, the capex the 10-K later filed for that year with the filed lines it sums. ' +
        'States: met (inside the range, or within tolerance_pct of a single figure), above, below, open (the year isn’t filed), unsettled (we don’t read the line the filer guides). error_pct is the distance outside the range. ' +
        'guidance.filers[] says how many releases each filer has and how many print a figure: Meta, Alphabet and Oracle are scored, Amazon is listed and not scored, and Microsoft prints none (guidance given only on the call is not read). ' +
        'alerts has the totals of get_track_record. Headlines come from GDELT, which misses Bloomberg, Reuters, the WSJ and the FT. Not investment advice. ' +
        PROVENANCE,
      inputSchema: z.object({ as_of: AsOfSchema }),
      annotations: READ_ONLY,
    },
    ({ as_of }) =>
      asOfErrors(async () =>
        json(
          await read(
            'ground-truth',
            as_of,
            (ctx) => queryGroundTruth(deps.db, ctx),
            await reportedStamp(deps.db),
          ),
        ),
      ),
  )
}
