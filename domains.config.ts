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
      // The SEC forms the shell's severity gates read.
      'server/pipeline/parsers/sec/forms.ts',
      // The prospectus floor's rule name, which the press notes read.
      'server/pipeline/prospectus-floor.ts',
    ],
  },
  press: {
    // The ground truth scores press reports against companies' filed revenue, facts and guidance.
    uses: ['core', 'companies'],
    public: [
      // Its queries (the reported figures, the track record, the ground truth and the press early
      // read), which the lab page, the tear sheet, the alerts tools, the theses and the signals read.
      'server/utils/',
      // The press notes, which the alerts layer's event fan-out composes and sends.
      'server/pipeline/press.ts',
      // The GKG file clock and the oldest unread file, which the shell's freshness reads.
      'server/pipeline/track-record/gkg.ts',
      'server/pipeline/track-record/search.ts',
      // The deal-score and revenue-score rules the shell's survey tick runs.
      'server/pipeline/deal-alerts.ts',
      'server/pipeline/revenue-alerts.ts',
    ],
  },
  compute: {
    // Its /hardware page lists the hardware suppliers (companies' suppliers table).
    uses: ['core', 'companies'],
    public: [
      // Its queries and its recipes, which the utilization query, the theses and the signals read.
      'server/utils/',
      'server/recipes/',
      // The power-site and prints readers and stamps the shell's filings tick, listed views and
      // fixture fill call by name (the prints are also a signal's source), and the GPU median
      // rule its survey tick runs.
      'server/power/ingest.ts',
      'server/power/stamp.ts',
      'server/prints/ingest.ts',
      'server/prints/parse.ts',
      'server/pipeline/gpu-median-floor.ts',
      // The data-center rule the same tick runs.
      'server/pipeline/datacenter-alerts.ts',
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
      // The archive eras and price and limit events the signals read.
      'server/pipeline/archive/',
      // The rate-limit rule the survey tick runs.
      'server/pipeline/limits-alerts.ts',
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
      // The hiring floor the shell's judge alert screen clamps and gates against.
      'server/pipeline/hiring-floor.ts',
      // The posted-pay rule the survey tick runs.
      'server/pipeline/pay-alerts.ts',
      // The archive trims the shell's lab, compare and tear-sheet pages apply.
      'app/utils/hiring-archive.ts',
      // The listed-company boards, which the shell's /api/hiring/listed serves, cut to a
      // lab's listed ties.
      'server/listed-hiring/query.ts',
    ],
  },
  reliability: {
    uses: ['core', 'pricing'],
    public: [
      // Its queries (incidents, the incident archive, the probes, the reliability record), which
      // the lab page, the tear sheet, the overview, the theses and the signals read.
      'server/utils/',
      // The OpenRouter id-to-lab map, which the adoption layer's rankings and spend reads share.
      'server/pipeline/parsers/openrouter.ts',
      // The probe placements the theses' capacity signals and the signals read.
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
      // The adoption rule the survey tick runs.
      'server/pipeline/adoption-alerts.ts',
    ],
  },
  models: {
    uses: ['core', 'pricing'],
    public: [
      // The launch-coverage watch, which the shell's ops watch spools from and its fleet
      // counters report.
      'server/pipeline/launch-watch.ts',
    ],
  },
  alerts: {
    // Supporting: the feed may read any domain. The social posts read the class map in effect
    // (pricing); the get_track_record tool and the press notes' send are press's.
    uses: ['core', 'pricing', 'press'],
    public: [
      // The confirmed-subscriber count the shell's fleet counters report, and the subscriber
      // fan-out and stale-pending purge the theses:digest task runs.
      'server/utils/subscribers.ts',
      'server/utils/subscriber-mail.ts',
      // The overview strip and the alert slimming the home page and the lab page apply.
      'app/utils/overview-strip.ts',
    ],
  },
  theses: {
    // Its claims read every domain but models. Its pages carry alerts' digest signup, and its
    // digest task runs alerts' subscriber fan-out and purge, handing it the digest to build.
    // It uses no signals code.
    uses: [
      'core',
      'companies',
      'compute',
      'pricing',
      'talent',
      'reliability',
      'adoption',
      'press',
      'alerts',
    ],
    public: [
      // The theses, which the crawler pages, the cache warm and the OG cards list.
      'server/theses/registry.ts',
      // The evaluator, which the shell's survey tick and the fixture fill run after the recipes.
      'server/theses/evaluate.ts',
    ],
  },
  signals: {
    // The series it tests come from every domain but models. It uses no theses code.
    uses: ['core', 'companies', 'compute', 'pricing', 'talent', 'reliability', 'adoption', 'press'],
    // Nothing beyond its shared/ types: the call reader gets its concepts through the app's
    // server/registries/call-concepts.ts, and its tools and tables register there too.
    public: [],
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
      'press',
      'alerts',
      'theses',
    ],
  },
} satisfies LayerTable
