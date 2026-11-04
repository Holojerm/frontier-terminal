<script setup lang="ts">
// The terminal's front page. Reading order is priority order: every lab on
// every axis, then what moved, then what things cost, then what has been
// disclosed, who is winning demand and where the implied dollars go, who is
// hiring, and how strained the APIs are. Each panel is the same component
// its axis page leads with, so the overview is the axis pages' summaries and
// nothing else. Nine cached endpoints, fetched in parallel on the server.

import { LABS } from '#layers/terminal/shared/utils/terminal-lab-summary'
import type {
  DisclosuresData,
  HiringHistoryData,
  IncidentsData,
  OverviewData,
  PricesData,
  RankingsData,
  ReleasesData,
  RevenueData,
  SpendData,
} from '#layers/terminal/shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '1.0',
    title: 'Overview',
    summary:
      'What moved across the frontier AI labs: judged alerts, change counts by axis, flagship API prices, disclosed revenue, demand and implied spend share, open roles and the infrastructure buildout, status-page incidents, and misalignment disclosures.',
  },
})

/** What this page needs from /api/incidents: the per-provider counts and a total. */
type IncidentsStrip = Omit<IncidentsData, 'incidents'> & { incident_count: number }

const config = useRuntimeConfig()

// One source for the site's one-sentence claim — also used by /llms.txt and
// the schema.org description, so all three agree.
const description = config.public.appDescription

// `pick`/`transform` run on the server, before Nuxt serialises the result into
// the hydration payload — so what is dropped here is not fetched-then-ignored,
// it never reaches the HTML. Both of these were most of this page's weight:
// /api/prices is 241 KB of which `rows` is 240 KB, and /api/incidents carries
// ~40 KB of incident rows this page reduces to a single count. The full catalog
// and the full list are each one link away on their own page, where they are
// actually rendered.
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
  useFetch<OverviewData>('/api/overview'),
  useFetch<PricesData>('/api/prices', { pick: ['as_of', 'computed_at', 'matrix', 'counts'] }),
  useFetch<RevenueData>('/api/revenue'),
  useFetch<RankingsData>('/api/rankings'),
  useFetch<SpendData>('/api/spend'),
  useFetch<ReleasesData>('/api/releases'),
  useFetch<HiringHistoryData>('/api/hiring/history'),
  // No `useFetch<IncidentsData>` here: the explicit generic pins the data type
  // as well as the response type, so a transform that reshapes cannot satisfy
  // it. Annotating the transform's input types both ends instead.
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

useSeo({
  // 'exact' because the brand should lead on the landing page — everywhere else
  // useSeo appends `· AppName` for you.
  titleMode: 'exact',
  title: `${config.public.appName}: sourced data on the frontier AI labs`,
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

const RECENT_RELEASES = 5
const recent = computed(() => releases.data.value?.rows.slice(0, RECENT_RELEASES) ?? [])

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
    <TerminalPanel
      id="readout"
      title="Readout"
      note="Each lab on every axis. Each figure links to the lab page, where its source is cited."
      flush
    >
      <TerminalReadoutStrip :labs="LABS" :data="readout" />
    </TerminalPanel>

    <div class="grid gap-6 lg:grid-cols-2">
      <TerminalSignalBand v-if="overview.data.value" :overview="overview.data.value" />

      <TerminalPanel
        id="releases"
        title="Recent releases"
        note="SKUs new on a tracked vendor page, with the launch price."
        :more="
          releases.data.value
            ? { label: `All ${releases.data.value.rows.length} releases`, to: '/releases' }
            : undefined
        "
        :flush="recent.length > 0"
      >
        <TerminalReleaseList v-if="recent.length" :rows="recent" />
        <TerminalGap v-else title="No new SKU since tracking began." />
      </TerminalPanel>
    </div>

    <TerminalPanel
      id="pricing"
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
    </TerminalPanel>

    <div class="grid gap-6 lg:grid-cols-2">
      <TerminalPanel
        id="revenue"
        title="Disclosed revenue"
        note="What each lab, or its public parent, has reported to the SEC."
        :more="{ label: 'Every period, restatements and filings', to: '/revenue' }"
        flush
      >
        <TerminalRevenueTable v-if="revenue.data.value" :revenue="revenue.data.value" />
      </TerminalPanel>
      <TerminalPanel
        id="hiring"
        title="Hiring"
        note="Open roles per board, the infrastructure cluster, and the department that moved most."
        :more="{ label: 'Roles per day, buildout, department mix', to: '/hiring' }"
        flush
      >
        <TerminalHiringSummary
          v-if="hiringHistory.data.value"
          :history="hiringHistory.data.value"
        />
      </TerminalPanel>
    </div>

    <div class="grid gap-6 lg:grid-cols-2">
      <TerminalPanel
        id="demand"
        title="Demand share"
        note="Share of all OpenRouter tokens, newest 7 days. A proxy, not market share."
        :more="{ label: '30-day series and top models', to: '/rankings' }"
      >
        <TerminalDemandShare v-if="rankings.data.value" :rankings="rankings.data.value" compact />
      </TerminalPanel>
      <TerminalPanel
        id="spend"
        title="Implied spend share"
        note="The tracked labs’ tokens at list price, as shares of those labs’ total, not of all OpenRouter traffic. A range, because some SKUs are unpriced."
        :more="{ label: 'Per-model join', to: '/rankings#spend' }"
      >
        <TerminalSpendShare v-if="spend.data.value" :spend="spend.data.value" compact />
      </TerminalPanel>
    </div>

    <!-- The strain table carries the open incident and its source; the
         disclosure counts are three short figures. Split 3:2, not 1:1. -->
    <div class="grid gap-6 lg:grid-cols-5">
      <TerminalPanel
        id="strain"
        class="lg:col-span-3"
        title="Capacity strain"
        :note="
          incidents.data.value
            ? `Status-page incidents, newest ${incidents.data.value.window_days} days against the prior ${incidents.data.value.window_days}. ${openIncidents} open now.`
            : 'Status-page incidents, newest 30 days against the prior 30.'
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
      </TerminalPanel>
      <TerminalPanel
        id="disclosures"
        class="lg:col-span-2"
        title="Disclosures"
        note="Misalignment reports each lab publishes about its own models. A count measures disclosure, not behavior."
        :more="{ label: 'Every report and notice', to: '/disclosures' }"
        flush
      >
        <TerminalDisclosureTable
          v-if="disclosures.data.value"
          :disclosures="disclosures.data.value"
        />
      </TerminalPanel>
    </div>
  </TerminalPage>
</template>
