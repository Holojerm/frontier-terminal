// get_listed_companies: every ticker the site ties to a lab, joining the companies
// layer's dependency graph and suppliers with the compute layer's power table. In
// the shell because it reads both; registered between the companies layer's
// exposure and identifier tools (server/registries/mcp-tools.ts).

import { z } from 'zod'
import { powerSitesStamp } from '#layers/compute/server/power/stamp'
import { suppliersStamp } from '#layers/companies/server/suppliers/store'
import { queryListed } from '../utils/terminal-listed'
import { json, READ_ONLY, PROVENANCE, type McpKit } from '#layers/core/server/mcp/kit'

export function registerListedTools({ server, deps }: McpKit): void {
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
      const [power, suppliers] = await Promise.all([
        powerSitesStamp(deps.db),
        suppliersStamp(deps.db),
      ])
      const data = await deps.serve(
        'listed',
        (ctx) => queryListed(deps.db, ctx),
        `${suppliers}:${power}`,
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
}
