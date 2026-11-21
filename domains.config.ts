// The fork-owned layers and what each may import, for `bun run domains:check`
// (scripts/check-domains.ts). Direction: core ← domains ← alerts / theses /
// signals ← terminal. A layer may import the layers in its `uses` and everything
// they use; a domain's `public` list names what other layers may read beyond
// its `shared/`. A new layer gets a row here in the PR that creates it.

import type { LayerTable } from './scripts/lib/domains'

export const DOMAIN_LAYERS = {
  core: { uses: [] },
  terminal: { uses: ['core'] },
} satisfies LayerTable
