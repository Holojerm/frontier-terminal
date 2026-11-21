// Capacity strain: published rate limits. Registered right after the reliability layer's
// incidents and probes (server/registries/mcp-tools.ts), where the tool list has always had it.

import { z } from 'zod'
import { recipeRunsStamp } from '#layers/core/server/utils/terminal-db'
import { LIMIT_RECIPE_IDS, queryLimits } from '../utils/terminal-limits'
import {
  ProviderSchema,
  json,
  READ_ONLY,
  PROVENANCE,
  type McpKit,
} from '#layers/core/server/utils/mcp-kit'

export function registerRateLimitTools({ server, deps }: McpKit): void {
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
        await recipeRunsStamp(deps.db, LIMIT_RECIPE_IDS),
      )
      if (!provider) return json(data)
      return json({ ...data, pages: data.pages.filter((p) => p.lab === provider) })
    },
  )
}
