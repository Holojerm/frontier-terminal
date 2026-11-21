// The fork-owned layers and what each may import, for `bun run domains:check`
// (scripts/check-domains.ts). Direction: core ← domains ← alerts / theses /
// signals ← terminal. A layer may import the layers in its `uses` and everything
// they use; a domain's `public` list names what other layers may read beyond
// its `shared/`. A new layer gets a row here in the PR that creates it.

import type { LayerTable } from './scripts/lib/domains'

export const DOMAIN_LAYERS = {
  core: { uses: [] },
  compute: {
    uses: ['core'],
    public: [
      // Its queries and its recipes, which the utilization query, the theses and the signals read.
      'server/utils/',
      'server/recipes/',
      // What the shell's ticks, judge and backfill still call by name until they read registries.
      'server/power/ingest.ts',
      'server/power/review.ts',
      'server/power/stamp.ts',
      'server/prints/ingest.ts',
      'server/prints/parse.ts',
      'server/pipeline/gpu-median-floor.ts',
      'server/pipeline/archive/gpu-eras.ts',
    ],
  },
  terminal: { uses: ['core', 'compute'] },
} satisfies LayerTable
