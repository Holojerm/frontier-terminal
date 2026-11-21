// The models layer's tools: the release timeline (every SKU a vendor page
// started listing after its baseline), registered right after the pricing
// layer's price tools, and the misalignment disclosures, registered right
// after the shell's get_rate_limits (server/registries/mcp-tools.ts).

import { z } from 'zod'
import { queryDisclosures } from '../utils/terminal-disclosures'
import { queryReleases } from '../utils/terminal-releases'
import {
  ProviderSchema,
  json,
  READ_ONLY,
  PROVENANCE,
  type McpKit,
} from '#layers/core/server/mcp/kit'

export function registerReleaseTools({ server, deps }: McpKit): void {
  server.registerTool(
    'get_releases',
    {
      title: 'Release timeline',
      description:
        'Every SKU first listed on a vendor page after that source’s baseline, newest first, with the price printed beside it ' +
        'when it was first seen (first_seen_at is the detection, not the vendor’s launch date) and also_listed_by for keys two ' +
        'pages carry. A row is an `added` change on a model entity — a listing event, so a rename or a tier split appears as a ' +
        'release. Baseline sightings are EXCLUDED: everything on a page at its first snapshot is a starting state, not a release, ' +
        'and excluded_baseline counts them; nothing before log_from could have been seen at all. Optional limit truncates rows ' +
        'and adds total. ' +
        PROVENANCE,
      inputSchema: z.object({ limit: z.number().int().min(1).max(500).optional() }),
      annotations: READ_ONLY,
    },
    async ({ limit }) => {
      const releases = await deps.serve('releases', (ctx) => queryReleases(deps.db, ctx))
      if (limit === undefined) return json(releases)
      return json({ ...releases, rows: releases.rows.slice(0, limit), total: releases.rows.length })
    },
  )
}

export function registerDisclosureTools({ server, deps }: McpKit): void {
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
