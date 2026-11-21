// The fork-owned layers and what each may import, for `bun run domains:check`
// (scripts/check-domains.ts). Direction: core ← domains ← alerts / theses /
// signals ← terminal. A layer may import the layers in its `uses` and everything
// they use; a domain's `public` list names what other layers may read beyond
// its `shared/`. A new layer gets a row here in the PR that creates it.

import type { LayerTable } from './scripts/lib/domains'

export const DOMAIN_LAYERS = {
  core: { uses: [] },
  companies: {
    uses: ['core'],
    public: [
      // Its queries (revenue, the prospectus, exposure, dependencies, suppliers, identifiers,
      // parents, the guidance score), which the lab page, the tear sheet, the listed table,
      // the ground truth, the utilization query, the theses and the signals read.
      'server/utils/',
      // Its recipes (the SEC revenue and investee facts), which the utilization query, the
      // theses and the signals read.
      'server/recipes/',
      // The filed-facts series, which the ground truth, the theses and the signals read, and
      // the reader the offline fixture fill runs.
      'server/exposure/series.ts',
      'server/exposure/ingest.ts',
      // The call reader's companies, periods and actuals, which the forward calls settle
      // against, and the reader they run.
      'server/calls/',
      // The suppliers' stamp and reader, which the listed table, the filings tick and the
      // fixture fill call.
      'server/suppliers/store.ts',
      'server/suppliers/ingest.ts',
      // The SEC forms the shell's severity gates read, and the whitelist its dictionary reads.
      'server/pipeline/parsers/sec/forms.ts',
      'server/pipeline/parsers/sec/whitelist.ts',
      // Its parser manifest, which the shell's manifest imports.
      'server/pipeline/parsers.manifest.ts',
      // The prospectus floor's rule name, which the shell's press notes read.
      'server/pipeline/prospectus-floor.ts',
    ],
  },
  compute: {
    // Its /hardware page lists the hardware suppliers (companies' suppliers table).
    uses: ['core', 'companies'],
    public: [
      // Its queries and its recipes, which the utilization query, the theses and the signals read.
      'server/utils/',
      'server/recipes/',
      // What the shell's ticks and backfill still call by name until they read registries.
      'server/power/ingest.ts',
      'server/power/stamp.ts',
      'server/prints/ingest.ts',
      'server/prints/parse.ts',
      'server/pipeline/gpu-median-floor.ts',
      'server/pipeline/archive/gpu-eras.ts',
    ],
  },
  pricing: {
    uses: ['core'],
    public: [
      // Its queries (prices, the class map, the archived price lists and limits), which the
      // lab page, the tear sheet, the probes, the launch watch, the theses and the signals read.
      'server/utils/',
      // The class map in effect, which the probes, the tripwire, the launch watch, the social
      // posts, the theses and the judge runner read.
      'server/pipeline/class-map.ts',
      // The class-map re-mappings the shell's judge alert screen applies and gates on.
      'server/pipeline/judge/class-map.ts',
      // The archive eras and price and limit events the shell's backfill rows and signals read.
      'server/pipeline/archive/',
      // The price normalizer the shell's archive rows reuse, and its parser manifest.
      'server/pipeline/normalize.ts',
      'server/pipeline/parsers.manifest.ts',
      // The price formatting the lab readout and the tear sheet share.
      'app/utils/price-display.ts',
    ],
  },
  talent: {
    uses: ['core'],
    public: [
      // Its queries (open roles now and over time, the archived boards, posted pay, the
      // department clusters), which the lab page, the tear sheet, the theses and the signals read.
      'server/utils/',
      // The hiring floor the shell's judge runner clamps and reports against.
      'server/pipeline/hiring-floor.ts',
      // The archive eras the shell's backfill rows read.
      'server/pipeline/archive/hiring-eras.ts',
      // Its parser manifest, which the shell's manifest imports.
      'server/pipeline/parsers.manifest.ts',
      // The archive trims the shell's lab, compare and tear-sheet pages apply.
      'app/utils/hiring-archive.ts',
    ],
  },
  reliability: {
    uses: ['core', 'pricing'],
    public: [
      // Its queries (incidents, the incident archive, the probes, the reliability record), which
      // the lab page, the tear sheet, the overview, the theses and the signals read.
      'server/utils/',
      // The OpenRouter id-to-lab map, which the shell's rankings and spend reads share.
      'server/pipeline/parsers/openrouter.ts',
      // Its parser manifest, which the shell's manifest imports.
      'server/pipeline/parsers.manifest.ts',
      // The status-feed archive eras the shell's backfill rows read.
      'server/pipeline/archive/status-eras.ts',
      // The probe placements the shell's capacity signals read.
      'server/pipeline/probes/placement.ts',
      // The deploy watch the shell's ops watch and freshness read, and the deploy checks feed.ts reads.
      'server/pipeline/deploy-watch.ts',
      'server/pipeline/reliability/deploys.ts',
    ],
  },
  adoption: {
    uses: ['core', 'reliability'],
    public: [
      // Its queries (the demand share, the implied spend, the adoption view), which the lab
      // page, the tear sheet, the utilization query, the theses and the signals read.
      'server/utils/',
      // Its recipes and the download series derived from them, which the theses and the
      // signals read.
      'server/recipes/',
      // Its parser manifest, which the shell's manifest imports.
      'server/pipeline/parsers.manifest.ts',
    ],
  },
  models: {
    uses: ['core', 'pricing'],
    public: [
      // The launch-coverage watch, which the shell's ops watch spools from and its fleet
      // counters report.
      'server/pipeline/launch-watch.ts',
      // Its parser manifest, which the shell's manifest imports.
      'server/pipeline/parsers.manifest.ts',
    ],
  },
  terminal: {
    uses: [
      'core',
      'companies',
      'compute',
      'pricing',
      'talent',
      'reliability',
      'adoption',
      'models',
    ],
  },
} satisfies LayerTable
