<script setup lang="ts">
// The terminal's front page. Reading order is priority order: what moved,
// then what things cost, then what has actually been disclosed, then who is
// winning demand and where the implied dollars go, then what is new, then
// who is hiring and who is building capacity, then how strained the APIs
// are, then the coverage the rest rest on. Ten cached endpoints, fetched in
// parallel on the server.

import type {
  CoverageData,
  HiringData,
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
      'What moved across the frontier AI labs — judged alerts, change counts by axis, like-for-like API prices, disclosed revenue, demand and implied spend share, open roles by department, the physical-infrastructure buildout, status-page incidents, and source coverage.',
  },
})

const config = useRuntimeConfig()

// One source for the site's one-sentence claim — also used by /llms.txt and
// the schema.org description, so all three agree.
const description = config.public.appDescription

useSeo({
  // 'exact' because the brand should lead on the landing page — everywhere else
  // useSeo appends `· AppName` for you.
  titleMode: 'exact',
  title: config.public.appName,
  description,
})

const [
  overview,
  prices,
  revenue,
  rankings,
  spend,
  releases,
  hiring,
  hiringHistory,
  incidents,
  coverage,
] = await Promise.all([
  useFetch<OverviewData>('/api/overview'),
  useFetch<PricesData>('/api/prices'),
  useFetch<RevenueData>('/api/revenue'),
  useFetch<RankingsData>('/api/rankings'),
  useFetch<SpendData>('/api/spend'),
  useFetch<ReleasesData>('/api/releases'),
  useFetch<HiringData>('/api/hiring'),
  useFetch<HiringHistoryData>('/api/hiring/history'),
  useFetch<IncidentsData>('/api/incidents'),
  useFetch<CoverageData>('/api/coverage'),
])

const failed = computed(() =>
  [
    overview,
    prices,
    revenue,
    rankings,
    spend,
    releases,
    hiring,
    hiringHistory,
    incidents,
    coverage,
  ].some((r) => r.error.value !== null && r.error.value !== undefined),
)

const RECENT_RELEASES = 5
const recent = computed(() => releases.data.value?.rows.slice(0, RECENT_RELEASES) ?? [])
</script>

<template>
  <div class="space-y-12">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">{{ config.public.appName }}</h1>
      <p class="max-w-2xl text-muted">{{ description }}</p>
    </header>

    <UAlert
      v-if="failed"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Part of the terminal could not be read"
      description="A data endpoint failed to respond. The panels that did load are shown; nothing is inferred for the ones that did not."
    />

    <TerminalSignalBand v-if="overview.data.value" :overview="overview.data.value" />

    <TerminalPanel
      id="pricing"
      title="Like-for-like API pricing"
      note="$ per million tokens, on each vendor’s own flagship / balanced / economy recommendation."
    >
      <TerminalPriceMatrix v-if="prices.data.value" :matrix="prices.data.value.matrix" />
      <p v-if="prices.data.value" class="text-sm">
        <NuxtLink to="/prices" class="text-primary underline underline-offset-2">
          Full catalog — {{ prices.data.value.counts.total }} SKU rows,
          {{ prices.data.value.counts.priced }} priced
        </NuxtLink>
      </p>
    </TerminalPanel>

    <TerminalPanel
      id="revenue"
      title="Disclosed revenue"
      note="What each lab, or the public parent that consolidates it, has reported to the SEC — and an explicit blank where nothing audited exists."
    >
      <TerminalRevenuePanel v-if="revenue.data.value" :revenue="revenue.data.value" compact />
    </TerminalPanel>

    <TerminalPanel
      id="demand"
      title="Demand share"
      note="Each lab’s share of tokens routed through OpenRouter in the newest seven days — a proxy for relative demand while the labs are private."
    >
      <TerminalDemandShare v-if="rankings.data.value" :rankings="rankings.data.value" compact />
    </TerminalPanel>

    <TerminalPanel
      id="spend"
      title="Implied spend share"
      note="The same tokens at each vendor’s list price: where the dollars would go if the channel paid list — a range, with the labs it could not price named."
    >
      <TerminalSpendShare v-if="spend.data.value" :spend="spend.data.value" compact />
    </TerminalPanel>

    <TerminalPanel
      id="releases"
      title="Recent releases"
      note="SKUs that appeared on a vendor page already being watched, with the price printed beside them that day."
    >
      <template v-if="releases.data.value">
        <TerminalEmptyState
          v-if="recent.length === 0"
          title="No new SKUs since watching began."
          body="A baseline records what was already listed; a later poll can see a new listing."
          :action="{ label: 'About releases', to: '/releases' }"
        />
        <template v-else>
          <TerminalReleaseList :rows="recent" />
          <p class="text-sm">
            <NuxtLink to="/releases" class="text-primary underline underline-offset-2">
              All {{ releases.data.value.rows.length }} releases
            </NuxtLink>
          </p>
        </template>
      </template>
    </TerminalPanel>

    <TerminalPanel
      id="hiring"
      title="Hiring mix"
      note="Open roles by department, from each board’s current listing, and the change over the comparison window."
    >
      <TerminalHiringMix
        v-if="hiring.data.value"
        :hiring="hiring.data.value"
        :history="hiringHistory.data.value"
      />
      <p v-if="hiring.data.value" class="text-sm">
        <NuxtLink to="/hiring" class="text-primary underline underline-offset-2">
          Open roles over time
        </NuxtLink>
      </p>
    </TerminalPanel>

    <TerminalPanel
      id="buildout"
      title="Capacity buildout"
      note="Open roles in each board’s physical-infrastructure departments — data center, facilities, energy, construction, compute, hardware — the supply side of the strain panel below."
    >
      <TerminalBuildoutPanel
        v-if="hiringHistory.data.value"
        :history="hiringHistory.data.value"
        compact
      />
    </TerminalPanel>

    <TerminalPanel
      id="strain"
      title="Capacity strain"
      note="Incidents each lab posted on its own status page: the newest 30 days against the 30 before, and what is open now."
    >
      <TerminalStrainPanel v-if="incidents.data.value" :incidents="incidents.data.value" />
      <p v-if="incidents.data.value" class="text-sm">
        <NuxtLink to="/incidents" class="text-primary underline underline-offset-2">
          All incidents — {{ incidents.data.value.incidents.length }} in the last
          {{ incidents.data.value.history_days }} days
        </NuxtLink>
      </p>
    </TerminalPanel>

    <TerminalPanel
      id="coverage"
      title="Coverage"
      note="Every source behind the numbers above: newest snapshot, last poll, and the audit’s caveat."
    >
      <TerminalCoveragePanel v-if="coverage.data.value" :coverage="coverage.data.value" />
    </TerminalPanel>
  </div>
</template>
