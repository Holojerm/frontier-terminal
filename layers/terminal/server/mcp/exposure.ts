// The public companies around the labs: exposure, dependencies, suppliers, listed companies, identifiers.

import { z } from 'zod'
import { queryDependencies } from '../utils/terminal-dependencies'
import { buildSuppliers, SUPPLIERS_VERSION } from '../utils/terminal-suppliers'
import { queryListed } from '../utils/terminal-listed'
import { VIEW_RECIPES } from '../utils/terminal-recipe-views'
import { recipeRunsStamp } from '../utils/terminal-db'
import { queryExposure } from '../utils/terminal-exposure'
import { identifiersPayload } from '../utils/terminal-identifiers'
import { json, READ_ONLY, AsOfSchema, asOfErrors, PROVENANCE, type McpKit } from './kit'

export function registerExposureTools({ server, deps, read }: McpKit): void {
  server.registerTool(
    'get_exposure',
    {
      title: 'Hyperscaler capex, backlog and lab stakes (filed XBRL)',
      description:
        'Quarterly series from 2020 built from the filed XBRL facts of Microsoft, Alphabet, Amazon, Meta and Oracle: capex (the cash line each tags, with finance leases ' +
        'beside it where the filer counts them, never added), remaining performance obligations (total, plus Microsoft commercial and Google Cloud where tagged), ' +
        'and every fact Microsoft tags on OpenAI (msft:OpenAIGlobalLlcMember) and Amazon on Anthropic (amzn:AnthropicMember). Each series names its concept and dims; ' +
        'points are oldest first, each from the newest filing that reported it, with accession, form, filing date and filing_url. derived marks a quarter computed as a ' +
        'year-to-date figure less the one a quarter shorter (less names it). superseded lists values a later filing restated. These are the filer’s numbers: ' +
        'Microsoft’s OpenAI line is what Microsoft recognized, not OpenAI’s result, and Amazon’s marks are not Anthropic’s valuation. gaps lists what the filings ' +
        'don’t tag (Alphabet never names Anthropic). as_of keeps the facts filed before that UTC day, back to 2020. Optional group (capex, rpo, openai, anthropic) ' +
        'and ticker filters. ' +
        PROVENANCE,
      inputSchema: z.object({
        group: z.enum(['capex', 'rpo', 'openai', 'anthropic']).optional(),
        ticker: z.enum(['MSFT', 'GOOGL', 'AMZN', 'META', 'ORCL']).optional(),
        as_of: AsOfSchema,
      }),
      annotations: READ_ONLY,
    },
    ({ group, ticker, as_of }) =>
      asOfErrors(async () => {
        const exposure = await read(
          'exposure',
          as_of,
          (ctx) => queryExposure(deps.db, ctx),
          '',
          'filed',
        )
        return json({
          ...exposure,
          series: exposure.series.filter(
            (s) => (!group || s.group === group) && (!ticker || s.ticker === ticker),
          ),
          gaps: exposure.gaps.filter(
            (g) => (!group || g.group === group) && (!ticker || g.ticker === ticker),
          ),
        })
      }),
  )

  server.registerTool(
    'get_dependencies',
    {
      title: 'Dependency graph: who buys from and funds whom (filed)',
      description:
        'The labs and the public companies around them as a graph, from SEC filings only. nodes are companies: the five filers whose XBRL we read (Microsoft, Amazon, Alphabet, Meta, Oracle), ' +
        'each lab a filing names, and any other named counterparty (kind venture). A node carries two sizes from its own filing, each null where none is filed: contracts (a filer’s remaining ' +
        'performance obligations, which customers owe it; a lab’s aggregate contractual obligations from its prospectus, which it owes suppliers) and capex (the newest quarter). ' +
        'edges are directed. kind buys runs from the customer to the supplier (backlog, revenue, receivables the filer tags on the customer); kind funds runs from the investor to the lab ' +
        '(funding commitments, credit lines, stakes, marks). reporter is the node whose filing states every figure on the edge, so a figure is the filer’s number, never the lab’s. ' +
        'facts lists every figure with its label, value, unit, period, form, filing date and filing_url; weight is the first dollar figure, which the page uses for line width. ' +
        'Edges carry different kinds of figure (a backlog balance, an amount added in one quarter, a funding commitment), so do not sum weights. gaps lists what no filing gives: a lab with ' +
        'no filing of its own, obligations with no named supplier, filers and labs with no edge, and suppliers we don’t read (chips, power). unplaced lists figures tagged on a lab that are ' +
        'not on an edge. No press-reported deal is included. No as_of: use get_exposure for point-in-time series. Optional node filter keeps the edges touching one node id. ' +
        PROVENANCE,
      inputSchema: z.object({
        node: z
          .string()
          .max(40)
          .optional()
          .describe(
            'A node id: a lab id (openai, anthropic) or a ticker (MSFT, AMZN, GOOGL, META, ORCL).',
          ),
      }),
      annotations: READ_ONLY,
    },
    async ({ node }) => {
      const data = await deps.serve('dependencies', (ctx) => queryDependencies(deps.db, ctx))
      if (!node) return json(data)
      const edges = data.edges.filter((e) => e.from === node || e.to === node)
      const ids = new Set([node, ...edges.flatMap((e) => [e.from, e.to])])
      return json({ ...data, edges, nodes: data.nodes.filter((n) => ids.has(n.id)) })
    },
  )

  server.registerTool(
    'get_suppliers',
    {
      title:
        'Suppliers: chip, hardware and compute-rental companies tied to a lab or cloud (filed)',
      description:
        'The listed chip, foundry, networking, optics, server, compute-rental and data-center hosting companies whose own SEC filings tie them to a lab or a cloud. ' +
        'rows is one filed passage each: ticker, company, layer, relation (customer: the counterparty buys from the company; supplier: the company buys from it; ' +
        'investment: the company invests in it; investor: it holds a stake or warrant in the company; guarantee: the company guarantees its obligations; concentration: a customer the filing gives a share for and does not name), ' +
        'counterparty (the name, or for concentration the filing’s own label such as Customer A), counterparty_ticker, counterparty_lab, figures (value, unit, meaning; ' +
        'units usd, pct_revenue, pct_receivables, pct_backlog, shares, gw), form, filed, period, source_url, quote and fetched_at (when the quote was last found in the document). ' +
        'companies is one row per ticker: the counterparties its filings name, the tracked labs among them, top_named_share and top_unnamed_share (the largest share of its revenue ' +
        'a filing puts on one customer, named or not). A concentration row is tied to no lab or cloud: never infer who the customer is. Shares are for each company’s own fiscal period, ' +
        'and figures measure different things, so do not sum them. The table is read by hand and is not a complete list of suppliers; gaps says what is left out. ' +
        'Not investment advice. Optional ticker keeps one company; optional counterparty keeps rows naming a lab id or a counterparty ticker. ' +
        PROVENANCE,
      inputSchema: z.object({
        ticker: z
          .string()
          .max(8)
          .optional()
          .describe('A supplier ticker, such as NVDA, AMD, ANET or CRWV.'),
        counterparty: z
          .string()
          .max(40)
          .optional()
          .describe(
            'A lab id (openai, anthropic, xai) or a counterparty ticker (MSFT, META, NVDA).',
          ),
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, counterparty }) => {
      const data = await deps.serve('suppliers', async () => buildSuppliers(), SUPPLIERS_VERSION)
      if (!ticker && !counterparty) return json(data)
      const rows = data.rows.filter(
        (r) =>
          (!ticker || r.ticker === ticker.toUpperCase()) &&
          (!counterparty ||
            r.counterparty_lab === counterparty.toLowerCase() ||
            r.counterparty_ticker === counterparty.toUpperCase()),
      )
      const kept = new Set(rows.map((r) => r.ticker))
      return json({ ...data, rows, companies: data.companies.filter((c) => kept.has(c.ticker)) })
    },
  )

  server.registerTool(
    'get_listed_companies',
    {
      title: 'Listed companies: every ticker the site ties to a lab, in one list',
      description:
        'One row per listed company named by the dependency graph (get_dependencies), the suppliers table (get_suppliers) or the power table (the Compute page, /api/power-sites). ' +
        'A company carries lab (the tracked lab it is or owns), labs (tracked labs a filing names with it: an edge on the graph or a passage in its own filing), ' +
        'site_labs (tracked labs Epoch AI credits with a data-center site the company powers or hosts: a tie by site and by Epoch’s estimate, weaker than labs) and ties, one per table that names it. ' +
        'A graph tie has sells_to, funds and figures (how many filed figures its edges carry). A suppliers tie has layer, named (the counterparties its filings name, by relation), ' +
        'unnamed (passages giving a share for a customer the filing does not name) and passages. A power tie has roles (utility, generation, equipment, host) and sites. ' +
        'This list adds no figure of its own: read the figures and quotes from the table each tie comes from. A company with empty labs and site_labs is tied to no tracked lab by name, ' +
        'so never infer one. The rows are not ranked and are not a recommendation. Not investment advice. counts gives how many companies each table contributes. ' +
        'Optional lab keeps the companies tied to one lab id by filing, by site or as its parent. ' +
        PROVENANCE,
      inputSchema: z.object({
        lab: z.string().max(40).optional().describe('A lab id, such as openai, anthropic or meta.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ lab }) => {
      const power = await recipeRunsStamp(deps.db, VIEW_RECIPES.powerSites)
      const data = await deps.serve(
        'listed',
        (ctx) => queryListed(deps.db, ctx),
        `${SUPPLIERS_VERSION}:${power}`,
      )
      if (!lab) return json(data)
      const id = lab.toLowerCase()
      return json({
        ...data,
        companies: data.companies.filter(
          (c) => c.lab === id || c.labs.includes(id) || c.site_labs.includes(id),
        ),
      })
    },
  )

  server.registerTool(
    'get_identifiers',
    {
      title: 'Security-master identifiers',
      description:
        'identifiers: one row per company the site names (each lab, each SEC filer we read, each comparison company) with its legal name, ' +
        'country, listing status (listed, registered, subsidiary, private), CIK, LEI and, when listed, ticker, MIC and US composite FIGI. ' +
        'Each identifier has its own _source_url and _fetched_at, and a null LEI has its reason in lei_note. entity_id is the value of every ' +
        'provider and company field in the other tools, so join on it. securities: which listed security carries each lab (self, a parent ' +
        'that consolidates it, or an investor that discloses a stake) with disclosed_in, the filing that says so. A stake is never inferred ' +
        'from press. Optional entity filter. ' +
        PROVENANCE,
      inputSchema: z.object({
        entity: z
          .string()
          .regex(/^[a-z][a-z-]{0,39}$/)
          .optional()
          .describe('An entity_id, e.g. anthropic, alphabet, microsoft.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ entity }) =>
      json(await deps.serve('identifiers', async () => identifiersPayload(entity), entity ?? '')),
  )
}
