// List first listings: every SKU a vendor page started listing after its
// baseline. Registered right after the pricing layer's price tools.

import { z } from 'zod'
import { queryReleases } from '../utils/terminal-releases'
import { json, READ_ONLY, PROVENANCE, type McpKit } from '#layers/core/server/mcp/kit'

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
