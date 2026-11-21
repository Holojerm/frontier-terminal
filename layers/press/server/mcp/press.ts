// The press reports and their scores against the filings: get_reported and
// get_ground_truth. Registered right after the companies layer's filing tools and
// before its exposure tools (server/registries/mcp-tools.ts).

import { z } from 'zod'

export function registerPressTools({ server, deps, read }: McpKit): void {
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
