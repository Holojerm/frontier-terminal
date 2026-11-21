<script setup lang="ts">
// The front page. Reading order is priority order: every lab on every axis, the figures
// around the labs and what moved; then the axes under the nav's Economics and Operations
// groups. Each panel is the one its axis page leads with. Fourteen cached endpoints,
// fetched in parallel on the server.

import type { IncidentsData } from '#layers/reliability/shared/types/incidents'
import type { ReleasesData } from '#layers/models/shared/types/releases'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '1.0',
    title: 'Overview',
    summary:
      'What changed at the frontier AI labs, with judged alerts, flagship API prices, disclosed revenue and press reports scored against it, listed companies tied to the labs, GPU rental prices and utilization, the newest thesis status, demand and implied spend share, open roles, status-page incidents, and misalignment disclosures.',
  },
})

const RECENT_RELEASES = 5
/** The newest RECENT_RELEASES, and how many there are in all. */
type ReleasesStrip = ReleasesData & { release_count: number }

/** What this page needs from /api/incidents: the per-provider counts and a total. */
type IncidentsStrip = Omit<IncidentsData, 'incidents'> & { incident_count: number }

const config = useRuntimeConfig()

// Shared with /llms.txt and the schema.org description, so all three agree.
const description = config.public.appDescription

// The fundamentals row reads one figure (and its citation) from each of these. Started
// before the other nine are awaited, so all fourteen run at once.
const fundamentalsFetch = Promise.all([
  useFetch('/api/ground-truth', { transform: truthFigure }),
  useFetch('/api/listed', { transform: listedFigure }),
  useFetch('/api/gpu-prices', { transform: gpuFigure }),
  useFetch('/api/utilization', { transform: utilizationFigure }),
  useFetch('/api/theses', { transform: thesisFigure }),
])

// `pick`/`transform` run on the server before serialization, so what is dropped never
// reaches the HTML. /api/prices is 241 KB (240 KB of it `rows`) and /api/incidents carries
// ~40 KB of rows this page reduces to a count.
const [
  overview,
  prices,
  revenue,
  rankings,
  spend,
  releases,
  hiringHistory,
  incidents,
  disclosures,
] = await Promise.all([
  // The band and readout read a handful of alerts; see overviewStrip.
  useFetch<OverviewData>('/api/overview', {
    transform: (d: OverviewData): OverviewData => overviewStrip(d, LABS),
  }),
  useFetch<PricesData>('/api/prices', { pick: ['as_of', 'computed_at', 'matrix', 'counts'] }),
  useFetch<RevenueData>('/api/revenue'),
  // The compact demand and spend panels read shares and totals only: the
  // 30-day series, the top models and the per-model join are on /rankings.
  useFetch<RankingsData>('/api/rankings', {
    transform: (d: RankingsData): RankingsData => ({ ...d, series: [], top_models: [] }),
  }),
  useFetch<SpendData>('/api/spend', {
    transform: (d: SpendData): SpendData => ({
      ...d,
      providers: d.providers.map((p) => ({ ...p, models: [] })),
    }),
  }),
  useFetch('/api/releases', {
    transform: (d: ReleasesData): ReleasesStrip => ({
      ...d,
      rows: d.rows.slice(0, RECENT_RELEASES),
      release_count: d.rows.length,
    }),
  }),
  // The department mix is drawn on /hiring; the summary here never reads it.
  useFetch<HiringHistoryData>('/api/hiring/history', {
    transform: (d: HiringHistoryData): HiringHistoryData => ({
      ...withoutArchive(d),
      providers: d.providers.map((p) => ({ ...p, departments: [], archived: [] })),
    }),
  }),
  // No `useFetch<IncidentsData>`: the explicit generic pins the data type too, so a
  // reshaping transform cannot satisfy it. The transform's input is annotated instead.
  useFetch('/api/incidents', {
    transform: ({ incidents: rows, ...rest }: IncidentsData): IncidentsStrip => ({
      ...rest,
      incident_count: rows.length,
    }),
  }),
  useFetch('/api/disclosures', {
    transform: ({
      entries: _entries,
      ...rest
    }: DisclosuresData): Omit<DisclosuresData, 'entries'> => rest,
  }),
])

const fundamentals = await fundamentalsFetch
const fundamentalFigures = computed(() =>
  fundamentals.flatMap((r) => (r.data.value ? [r.data.value] : [])),
)

useSeo({
  // 'exact' so the brand leads; elsewhere useSeo appends `· AppName`.
  titleMode: 'exact',
  title: `${config.public.appName}: fundamentals on the frontier AI labs`,
  description,
  dateModified: overview.data.value?.as_of,
})

const failed = computed(() =>
  [
    overview,
    prices,
    revenue,
    rankings,
    spend,
    releases,
    hiringHistory,
    incidents,
    disclosures,
    ...fundamentals,
  ].some((r) => r.error.value !== null && r.error.value !== undefined),
)

// The readout row reads the same payloads the panels below render.
const readout = computed(() => ({
  prices: prices.data.value,
  revenue: revenue.data.value,
  rankings: rankings.data.value,
  spend: spend.data.value,
  hiring: hiringHistory.data.value,
  incidents: incidents.data.value,
  alerts: [...(overview.data.value?.alerts ?? []), ...(overview.data.value?.info ?? [])].sort(
    (a, b) => b.created_at.localeCompare(a.created_at),
  ),
}))

const recent = computed(() => releases.data.value?.rows ?? [])

// A panel whose request failed says so. Left empty, or filled with its
// no-rows line, it would state something about the data we did not read.
const NOT_LOADED = 'Didn’t load.'

const openIncidents = computed(() =>
  (incidents.data.value?.providers ?? []).reduce((n, p) => n + p.open.length, 0),
)
</script>

<template>
  <TerminalPage
    :title="config.public.appName"
    :lede="description"
    :as-of="overview.data.value?.as_of"
    :error="failed"
  >
    <TerminalPanel id="readout" title="Readout" note="Each lab at a glance." flush>
      <TerminalReadoutStrip :labs="LABS" :data="readout" />
    </TerminalPanel>

    <TerminalPanel
      v-if="fundamentalFigures.length"
      id="fundamentals"
      title="Around the labs"
      note="Press reports against filings, the listed companies tied to the labs, compute, and the theses."
    >
      <dl class="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        <TerminalFigure
          v-for="f in fundamentalFigures"
          :key="f.label"
          :label="f.label"
          :value="f.value"
          :sub="f.sub"
          :to="f.to"
          :source="f.source"
          :gap="f.gap"
        />
      </dl>
    </TerminalPanel>

    <div class="grid gap-6 lg:grid-cols-2">
      <TerminalSignalBand v-if="overview.data.value" :overview="overview.data.value" />

      <TerminalPanel
        id="releases"
        title="Recent releases"
        note="SKUs newly listed on a vendor’s pricing page, with the launch price."
        :more="
          releases.data.value
            ? { label: `All ${releases.data.value.release_count} releases`, to: '/releases' }
            : undefined
        "
        :flush="recent.length > 0"
      >
        <TerminalReleaseList v-if="recent.length" :rows="recent" />
        <TerminalGap v-else-if="releases.data.value" title="No new SKU since tracking began." />
        <TerminalGap v-else :title="NOT_LOADED" />
      </TerminalPanel>
    </div>

    <TerminalGroup
      id="economics"
      title="Economics"
      note="What the labs charge, what they have reported earning, and whose models the tokens go to."
    >
      <TerminalPanel
        id="pricing"
        :level="3"
        title="API prices"
        note="$ per million tokens, like for like on each vendor’s own recommendation."
        :more="
          prices.data.value
            ? { label: `All ${prices.data.value.counts.priced} priced SKUs`, to: '/prices' }
            : undefined
        "
        flush
      >
        <TerminalPriceMatrix v-if="prices.data.value" :matrix="prices.data.value.matrix" />
        <TerminalGap v-else :title="NOT_LOADED" />
      </TerminalPanel>

      <TerminalPanel
        id="revenue"
        :level="3"
        title="Disclosed revenue"
        note="What each lab, or its public parent, has reported to the SEC."
        :more="{ label: 'Every period, restatement, and filing', to: '/revenue' }"
        flush
      >
        <TerminalRevenueTable v-if="revenue.data.value" :revenue="revenue.data.value" />
        <TerminalGap v-else :title="NOT_LOADED" />
      </TerminalPanel>

      <div class="grid gap-6 lg:grid-cols-2">
        <TerminalPanel
          id="demand"
          :level="3"
          title="Demand share"
          note="Share of OpenRouter tokens, last 7 days."
          :more="{ label: '30-day series and top models', to: '/rankings' }"
        >
          <TerminalDemandShare v-if="rankings.data.value" :rankings="rankings.data.value" />
          <TerminalGap v-else :title="NOT_LOADED" />
        </TerminalPanel>
        <TerminalPanel
          id="spend"
          :level="3"
          title="Implied spend share"
          note="The tracked labs’ tokens at list price, as a low–high range. Share of the tracked labs’ total."
          :more="{ label: 'Per-model join', to: '/rankings#spend' }"
        >
          <TerminalSpendShare v-if="spend.data.value" :spend="spend.data.value" compact />
          <TerminalGap v-else :title="NOT_LOADED" />
        </TerminalPanel>
      </div>
    </TerminalGroup>

    <TerminalGroup
      id="operations"
      title="Operations"
      note="Who the labs are hiring, how their APIs are holding up, and what they disclose about their own models."
    >
      <TerminalPanel
        id="hiring"
        :level="3"
        title="Hiring"
        note="Open roles per board, infrastructure roles, and the department that changed most."
        :more="{ label: 'Roles per day, buildout, department mix', to: '/hiring' }"
        flush
      >
        <TerminalHiringSummary
          v-if="hiringHistory.data.value"
          :history="hiringHistory.data.value"
        />
        <TerminalGap v-else :title="NOT_LOADED" />
      </TerminalPanel>

      <!-- The strain table carries the open incident and its source; the
           disclosure counts are three short figures. Split 3:2, not 1:1. -->
      <div class="grid gap-6 lg:grid-cols-5">
        <TerminalPanel
          id="strain"
          :level="3"
          class="lg:col-span-3"
          title="Capacity strain"
          :note="
            incidents.data.value
              ? `Status-page incidents in the last ${incidents.data.value.window_days} days, against the ${incidents.data.value.window_days} before. ${openIncidents} open now.`
              : 'Status-page incidents in the last 30 days, against the 30 before.'
          "
          :more="
            incidents.data.value
              ? {
                  label: `All ${incidents.data.value.incident_count} incidents in ${incidents.data.value.history_days} days`,
                  to: '/incidents',
                }
              : undefined
          "
          flush
        >
          <TerminalStrainTable v-if="incidents.data.value" :incidents="incidents.data.value" />
          <TerminalGap v-else :title="NOT_LOADED" />
        </TerminalPanel>
        <TerminalPanel
          id="disclosures"
          :level="3"
          class="lg:col-span-2"
          title="Disclosures"
          note="Misalignment reports each lab publishes about its own models. A count is what a lab discloses, not how often models misbehave."
          :more="{ label: 'Every report and notice', to: '/disclosures' }"
          flush
        >
          <TerminalDisclosureTable
            v-if="disclosures.data.value"
            :disclosures="disclosures.data.value"
          />
          <TerminalGap v-else :title="NOT_LOADED" />
        </TerminalPanel>
      </div>
    </TerminalGroup>

    <TerminalSubscribeForm />
  </TerminalPage>
</template>
