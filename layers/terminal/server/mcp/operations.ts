// Capacity strain and safety: published rate limits and misalignment disclosures. The incidents
// and latency probes are the reliability layer's (layers/reliability/server/mcp/reliability.ts).

import { z } from 'zod'
import { recipeRunsStamp } from '#layers/core/server/utils/terminal-db'
import { queryLimits } from '#layers/pricing/server/utils/terminal-limits'
import { VIEW_RECIPES } from '../utils/terminal-recipe-views'
import { queryDisclosures } from '../utils/terminal-disclosures'
import {
  ProviderSchema,
  json,
  READ_ONLY,
  PROVENANCE,
  type McpKit,
} from '#layers/core/server/mcp/kit'

export function registerOperationsTools({ server, deps }: McpKit): void {
  server.registerTool(
    'get_rate_limits',
    {
      title: 'Published API rate limits',
      description:
        'The API rate limits OpenAI, Anthropic, xAI and Meta publish in their docs. pages is one per lab’s limits page: covers says what it covers, metrics names the columns ' +
        '(requests or tokens per minute, per day, …), and rows is one per model and tier with values per metric (null is none published) and text where the page gives a limit in words ' +
        '(“256 concurrent streams”). snapshot is the newest reading and previous the one before it once a change has been seen; changed counts the limits that differ between them. ' +
        'A new reading is stored only when a limit changes. Limits reflect tier design and abuse control as much as capacity, and they change in announced steps, so a raised limit is not a measure of spare capacity. ' +
        'Google and Mistral publish no per-model limits. archived, where not null, is what Internet Archive copies of the same page show before our first read: how many copies were read, their span, and each limit that moved between two copies (before, after, and the two copies’ times; the change happened between them). ' +
        'Optional provider keeps one lab’s page. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const data = await deps.serve(
        'limits',
        () => queryLimits(deps.db),
        await recipeRunsStamp(deps.db, VIEW_RECIPES.limits),
      )
      if (!provider) return json(data)
      return json({ ...data, pages: data.pages.filter((p) => p.lab === provider) })
    },
  )

  server.registerTool(
    'get_disclosures',
    {
      title: 'Misalignment disclosures',
      description:
        'Each lab’s own index of misalignment reports and notices — agents leaving their sandbox, messaging each other through ' +
        'public services, deceiving in their own summaries. Only OpenAI publishes one (openai.com/safety-alignment/misalignment-reports);' +
        'every other lab is reported as no_public_feed with the audit’s reason, never as zero. A count measures ' +
        'disclosure practice, not how often misalignment happens: never rank labs on it. entries carries every report and notice ' +
        'with title, summary, model and observed_during VERBATIM, and for a report its page’s dates: discovered_on, disclosed_on ' +
        '(disclosed_basis says whether the page printed it or it is the earliest date the index has shown), and ' +
        'days_to_disclosure between them. timeline_status says why a report has no dates (not_fetched, title_mismatch). Per ' +
        'provider, report and notice counts and the median days_to_disclosure over timed_reports. Optional provider filter. ' +
        PROVENANCE,
      inputSchema: z.object({ provider: ProviderSchema.optional() }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const disclosures = await deps.serve('disclosures', (ctx) => queryDisclosures(deps.db, ctx))
      if (!provider) return json(disclosures)
      return json({
        ...disclosures,
        providers: disclosures.providers.filter((p) => p.provider === provider),
        entries: disclosures.entries.filter((e) => e.provider === provider),
      })
    },
  )
}
