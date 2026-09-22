<script setup lang="ts">
// The terminal's front page. Reading order is priority order: what moved,
// then what things cost, then what has actually been disclosed, then who is
// winning demand and where the implied dollars go, then who is hiring, then
// how strained the APIs are. Department mix, the buildout series, the full
// catalog and source coverage are each one link away on their own page.
// Eight cached endpoints, fetched in parallel on the server.

import { LABS } from '#shared/utils/terminal-lab-summary'
import type {
  HiringHistoryData,
  IncidentsData,
  OverviewData,
  PricesData,
  RankingsData,
  ReleasesData,
  RevenueData,
  SpendData,
} from '#shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '1.0',
    title: 'Overview',
    summary:
      'What moved across the frontier AI labs — judged alerts, change counts by axis, flagship API prices, disclosed revenue, demand and implied spend share, open roles and the infrastructure buildout, and status-page incidents.',
  },
})

const config = useRuntimeConfig()

// One source for the site's one-sentence claim — also used by /llms.txt and
// the schema.org description, so all three agree.
const description = config.public.appDescription

const [overview, prices, revenue, rankings, spend, releases, hiringHistory, incidents] =
  await Promise.all([
    useFetch<OverviewData>('/api/overview'),
    useFetch<PricesData>('/api/prices'),
    useFetch<RevenueData>('/api/revenue'),
    useFetch<RankingsData>('/api/rankings'),
    useFetch<SpendData>('/api/spend'),
    useFetch<ReleasesData>('/api/releases'),
    useFetch<HiringHistoryData>('/api/hiring/history'),
    useFetch<IncidentsData>('/api/incidents'),
  ])

useSeo({
  // 'exact' because the brand should lead on the landing page — everywhere else
  // useSeo appends `· AppName` for you.
  titleMode: 'exact',
  title: config.public.appName,
  description,
  dateModified: overview.data.value?.as_of,
})

const failed = computed(() =>
  [overview, prices, revenue, rankings, spend, releases, hiringHistory, incidents].some(
    (r) => r.error.value !== null && r.error.value !== undefined,
  ),
)

// The readout row reads the same payloads the panels below render.
const readout = computed(() => ({
  prices: prices.data.value,
  revenue: revenue.data.value,
  rankings: rankings.data.value,
  spend: spend.data.value,
  hiring: hiringHistory.data.value,
  incidents: incidents.data.value,
  alerts: [...(overview.data.value?.alerts ?? []), ...(overview.data.value?.ticker ?? [])].sort(
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
  <div class="space-y-12">
    <header class="space-y-4">
      <div class="space-y-1">
        <h1 class="text-2xl text-highlighted">{{ config.public.appName }}</h1>
        <p class="max-w-2xl text-sm text-muted">{{ description }}</p>
      </div>
      <TerminalReadoutStrip :labs="LABS" :data="readout" link-labs />
    </header>

    <UAlert
      v-if="failed"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Part of the terminal could not be read"
      description="A data endpoint failed to respond. The panels that did load are shown."
    />

    <TerminalSignalBand v-if="overview.data.value" :overview="overview.data.value" />

    <TerminalPanel
      id="pricing"
      title="Flagship API price"
      note="$ per million tokens, on each vendor’s own “start here” model."
    >
      <TerminalFlagshipGrid v-if="prices.data.value" :matrix="prices.data.value.matrix" />
      <p v-if="prices.data.value" class="text-sm">
        <NuxtLink to="/prices" class="text-primary underline underline-offset-2">
          Balanced and economy tiers, and all
          {{ prices.data.value.counts.priced }} priced SKUs
        </NuxtLink>
      </p>
    </TerminalPanel>

    <TerminalPanel
      id="revenue"
      title="Disclosed revenue"
      note="What each lab, or its public parent, has reported to the SEC."
    >
      <TerminalRevenuePanel v-if="revenue.data.value" :revenue="revenue.data.value" compact />
    </TerminalPanel>

    <div class="grid gap-12 lg:grid-cols-2">
      <TerminalPanel
        id="demand"
        title="Demand share"
        note="Share of OpenRouter tokens, newest 7 days. A proxy, not market share."
      >
        <TerminalDemandShare v-if="rankings.data.value" :rankings="rankings.data.value" compact />
      </TerminalPanel>

      <TerminalPanel
        id="spend"
        title="Implied spend share"
        note="The same tokens at list price. A range, because some SKUs are unpriced."
      >
        <TerminalSpendShare v-if="spend.data.value" :spend="spend.data.value" compact />
      </TerminalPanel>
    </div>

    <TerminalPanel
      v-if="recent.length"
      id="releases"
      title="Recent releases"
      note="SKUs that appeared on a watched vendor page, with the launch price."
    >
      <TerminalReleaseList :rows="recent" />
      <p v-if="releases.data.value" class="text-sm">
        <NuxtLink to="/releases" class="text-primary underline underline-offset-2">
          All {{ releases.data.value.rows.length }} releases
        </NuxtLink>
      </p>
    </TerminalPanel>

    <TerminalPanel
      id="hiring"
      title="Hiring"
      note="Open roles per board, the infrastructure cluster, and the department that moved most."
    >
      <TerminalHiringSummary v-if="hiringHistory.data.value" :history="hiringHistory.data.value" />
      <p class="text-sm">
        <NuxtLink to="/hiring" class="text-primary underline underline-offset-2">
          Roles per day, buildout series, department mix
        </NuxtLink>
      </p>
    </TerminalPanel>

    <TerminalPanel
      id="strain"
      title="Capacity strain"
      :note="
        incidents.data.value
          ? `Status-page incidents, newest ${incidents.data.value.window_days} days against the prior ${incidents.data.value.window_days}. ${openIncidents} open now.`
          : 'Status-page incidents, newest 30 days against the prior 30.'
      "
    >
      <TerminalStrainPanel v-if="incidents.data.value" :incidents="incidents.data.value" />
      <p v-if="incidents.data.value" class="text-sm">
        <NuxtLink to="/incidents" class="text-primary underline underline-offset-2">
          All {{ incidents.data.value.incidents.length }} incidents in
          {{ incidents.data.value.history_days }} days
        </NuxtLink>
      </p>
    </TerminalPanel>
  </div>
</template>
