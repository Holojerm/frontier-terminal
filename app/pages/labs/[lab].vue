<script setup lang="ts">
// One lab across every axis: the readout row, the alerts that cite it, then
// each axis panel filtered to the lab. The panels are the same components
// the axis pages render, handed a payload narrowed to one provider, so a
// number here is the same number there — same query, same cache, same
// provenance. The lab is a route parameter; a name outside the four is a 404.

import { sharePct, ppLabel } from '#shared/utils/terminal-format'
import { isLab, summarizeLab } from '#shared/utils/terminal-lab-summary'
import { alertLabs } from '#shared/utils/terminal-labs'
import type {
  AlertsData,
  HiringHistoryData,
  IncidentsData,
  PricesData,
  RankingsData,
  ReleasesData,
  RevenueData,
  SpendData,
} from '#shared/utils/terminal-types'

// Inert for a dynamic route: the collecting hook skips paths with a
// parameter, and sitemap.xml / llms.txt append the four lab pages from
// shared/utils/terminal-lab-summary.ts. Declared anyway — the seo gate's
// invariant is per-page.
definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.9',
    title: 'Lab',
    summary:
      'One frontier lab on every axis: flagship API price, disclosed revenue, OpenRouter demand and implied spend share, open roles and the infrastructure buildout, status-page incidents, and the alerts that cite it.',
  },
})

const route = useRoute()
const labParam = String(route.params.lab ?? '')
if (!isLab(labParam)) {
  throw createError({ statusCode: 404, statusMessage: 'No such lab', fatal: true })
}
const lab = labParam

// Every panel on this page is one lab's slice of an all-lab payload, and the
// filtering used to happen in the computeds below — after Nuxt had already
// serialised the whole thing into the hydration payload. `transform` runs on
// the server, before serialisation, so the other three labs' rows never reach
// the HTML. The shapes are unchanged: these return the same types, with fewer
// rows in them.
//
// EXPLICIT `key` PER LAB, and it is load-bearing. Nuxt derives an automatic key
// from the call site, not from what a transform closes over — so all four lab
// pages would share one cache entry and a client-side navigation between them
// would render the first lab's rows under the second lab's heading.
const [prices, revenue, rankings, spend, hiring, incidents, releases, alerts] = await Promise.all([
  useFetch<PricesData>('/api/prices', {
    key: `lab-prices:${lab}`,
    transform: (d: PricesData): PricesData => ({
      ...d,
      rows: d.rows.filter((r) => r.provider === lab),
    }),
  }),
  useFetch<RevenueData>('/api/revenue'),
  useFetch<RankingsData>('/api/rankings', {
    key: `lab-rankings:${lab}`,
    transform: (d: RankingsData): RankingsData => ({
      ...d,
      top_models: d.top_models.filter((m) => m.provider === lab),
    }),
  }),
  useFetch<SpendData>('/api/spend'),
  useFetch<HiringHistoryData>('/api/hiring/history'),
  useFetch<IncidentsData>('/api/incidents', {
    key: `lab-incidents:${lab}`,
    transform: (d: IncidentsData): IncidentsData => ({
      ...d,
      incidents: d.incidents.filter((i) => i.provider === lab),
    }),
  }),
  useFetch<ReleasesData>('/api/releases', {
    key: `lab-releases:${lab}`,
    transform: (d: ReleasesData): ReleasesData => ({
      ...d,
      rows: d.rows.filter((r) => r.provider === lab),
    }),
  }),
  // The big one: /api/alerts at tier=all&limit=200 is ~600KB, most of this
  // page's weight. `alertLabs` is the same predicate summarizeLab applies
  // below, so this narrows to exactly the rows the page was going to keep.
  useFetch<AlertsData>('/api/alerts', {
    key: `lab-alerts:${lab}`,
    query: { tier: 'all', limit: 200 },
    transform: (d: AlertsData): AlertsData => ({
      ...d,
      rows: d.rows.filter((a) => alertLabs(a).includes(lab)),
    }),
  }),
])

const data = computed(() => ({
  prices: prices.data.value,
  revenue: revenue.data.value,
  rankings: rankings.data.value,
  spend: spend.data.value,
  hiring: hiring.data.value,
  incidents: incidents.data.value,
  alerts: alerts.data.value?.rows ?? [],
}))

const summary = computed(() => summarizeLab(lab, data.value))
const display = summary.value.display

useSeo({
  title: display,
  description: `${display} on every axis: API price, SEC revenue, OpenRouter demand share, open roles, status-page incidents, and every alert that cites it.`,
  breadcrumb: [{ name: display, path: `/labs/${lab}` }],
  dateModified: alerts.data.value?.as_of,
})

const failed = computed(() =>
  [prices, revenue, rankings, spend, hiring, incidents, releases, alerts].some(
    (r) => r.error.value !== null && r.error.value !== undefined,
  ),
)

const ALERTS_SHOWN = 10
const labAlerts = computed(() => summary.value.alerts.slice(0, ALERTS_SHOWN))

// Each axis payload, narrowed to this lab. The components take the whole
// payload shape so the stamps, rules and citations travel with the rows.
const revenueOf = computed(() =>
  revenue.data.value && summary.value.revenue.view
    ? { ...revenue.data.value, providers: [summary.value.revenue.view] }
    : null,
)
const spendOf = computed(() =>
  spend.data.value && summary.value.spend
    ? {
        ...spend.data.value,
        providers: [summary.value.spend],
        excluded: spend.data.value.excluded.filter((e) => e.provider === lab),
      }
    : null,
)
const hiringOf = computed(() =>
  hiring.data.value && summary.value.hiring.view
    ? { ...hiring.data.value, providers: [summary.value.hiring.view] }
    : null,
)
const incidentsOf = computed(() =>
  incidents.data.value && summary.value.incidents
    ? { ...incidents.data.value, providers: [summary.value.incidents] }
    : null,
)
// A readout, not the catalog: priced rows only, a page of them, the rest on
// /prices with this lab preselected.
const CATALOG_ROWS = 15
// Already this lab's rows — the fetch above narrowed them server-side.
const labRows = computed(() => prices.data.value?.rows ?? [])
const pricesOf = computed(() =>
  prices.data.value
    ? {
        ...prices.data.value,
        rows: labRows.value
          .filter((r) => r.input_per_mtok !== null || r.output_per_mtok !== null)
          .slice(0, CATALOG_ROWS),
      }
    : null,
)
const topModels = computed(() => rankings.data.value?.top_models ?? [])
const labReleases = computed(() => releases.data.value?.rows ?? [])
const labIncidents = computed(() => incidents.data.value?.incidents.length ?? 0)
</script>

<template>
  <div class="space-y-12">
    <header class="space-y-4">
      <h1 class="text-2xl text-highlighted">{{ display }}</h1>
      <TerminalReadoutStrip :labs="[lab]" :data="data" />
    </header>

    <UAlert
      v-if="failed"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Part of this page could not be read"
      description="A data endpoint failed to respond. The panels that did load are shown."
    />

    <TerminalPanel
      id="alerts"
      title="Alerts"
      :note="`Alerts and ticker lines whose cited rows name ${display}, newest first.`"
    >
      <TerminalSignalTable v-if="labAlerts.length" :alerts="labAlerts" />
      <TerminalEmptyState v-else title="No alert cites this lab yet." />
      <p v-if="summary.alerts.length > labAlerts.length" class="text-sm">
        <NuxtLink to="/alerts" class="text-primary underline underline-offset-2">
          All {{ summary.alerts.length }} on the alerts page
        </NuxtLink>
      </p>
    </TerminalPanel>

    <TerminalPanel
      id="prices"
      title="API prices"
      note="$ per million tokens: the like-for-like classes, then every SKU on the vendor’s page."
    >
      <template v-if="prices.data.value">
        <TerminalPriceMatrix :matrix="prices.data.value.matrix" :providers="[lab]" compact />
        <TerminalEmptyState
          v-if="labRows.length === 0"
          title="No SKU rows for this lab yet."
          :action="{ label: 'See coverage', to: '/data#coverage' }"
        />
        <TerminalPriceTable v-else :prices="pricesOf!" />
        <p v-if="labRows.length > pricesOf!.rows.length" class="text-sm">
          <NuxtLink
            :to="`/prices?provider=${lab}#catalog`"
            class="text-primary underline underline-offset-2"
          >
            All {{ labRows.length }} {{ display }} SKUs, including batch and catalog-only rows
          </NuxtLink>
        </p>
      </template>
    </TerminalPanel>

    <TerminalPanel
      v-if="labReleases.length"
      id="releases"
      title="Releases"
      note="SKUs first seen on a watched page, with the launch price."
    >
      <TerminalReleaseList :rows="labReleases" />
    </TerminalPanel>

    <TerminalPanel
      id="revenue"
      title="Disclosed revenue"
      note="What the lab, or its public parent, has reported to the SEC."
    >
      <TerminalRevenuePanel v-if="revenueOf" :revenue="revenueOf" />
    </TerminalPanel>

    <div class="grid gap-12 lg:grid-cols-2">
      <TerminalPanel
        id="demand"
        title="Demand share"
        note="Share of OpenRouter tokens, newest 7 days. A proxy, not market share."
      >
        <template v-if="rankings.data.value?.status === 'ok' && summary.demand">
          <p class="font-mono text-sm">
            <span class="text-2xl text-highlighted">{{ sharePct(summary.demand.share) }}</span>
            <span v-if="summary.demand.delta_pp !== null" class="ml-2 text-toned">
              {{ ppLabel(summary.demand.delta_pp) }} vs prior 7 days
            </span>
          </p>
          <TerminalRankingsTopModels :providers="topModels" />
          <p class="text-sm">
            <NuxtLink to="/rankings" class="text-primary underline underline-offset-2">
              Every lab, and the 30-day series
            </NuxtLink>
          </p>
        </template>
        <TerminalEmptyState v-else title="No rankings rows yet." />
      </TerminalPanel>

      <TerminalPanel
        id="spend"
        title="Implied spend share"
        note="This lab’s OpenRouter tokens at its list prices, per model."
      >
        <TerminalSpendShare v-if="spendOf" :spend="spendOf" />
        <TerminalEmptyState v-else title="No rankings rows yet." />
      </TerminalPanel>
    </div>

    <TerminalPanel
      id="hiring"
      title="Hiring"
      note="Open roles now, the change over the window, and the infrastructure cluster."
    >
      <TerminalHiringSummary v-if="hiringOf" :history="hiringOf" />
      <p class="text-sm">
        <NuxtLink :to="`/hiring#${lab}`" class="text-primary underline underline-offset-2">
          Department mix, the buildout cluster and the daily series
        </NuxtLink>
      </p>
    </TerminalPanel>

    <TerminalPanel
      id="incidents"
      title="Capacity strain"
      :note="
        incidents.data.value
          ? `Status-page incidents, newest ${incidents.data.value.window_days} days against the prior ${incidents.data.value.window_days}.`
          : 'Status-page incidents.'
      "
    >
      <TerminalStrainPanel v-if="incidentsOf" :incidents="incidentsOf" />
      <p v-if="labIncidents" class="text-sm">
        <NuxtLink to="/incidents" class="text-primary underline underline-offset-2">
          All {{ labIncidents }} incidents in {{ incidents.data.value?.history_days }} days
        </NuxtLink>
      </p>
    </TerminalPanel>
  </div>
</template>
