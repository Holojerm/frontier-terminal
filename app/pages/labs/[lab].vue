<script setup lang="ts">
// One lab across every axis: the readout as figures, the alerts that cite it, then
// each axis panel filtered to the lab. The panels are the same components
// the axis pages render, handed a payload narrowed to one provider, so a
// number here is the same number there — same query, same cache, same
// provenance. The lab is a route parameter; a name outside the tracked labs is a 404.

import { isLab, summarizeLab } from '#shared/utils/terminal-lab-summary'
import { alertLabs, LAB_SITE } from '#shared/utils/terminal-labs'
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
// parameter, and sitemap.xml / llms.txt append the lab pages from
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
// from the call site, not from what a transform closes over — so all the lab
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
const figures = computed(() => readoutCells(summary.value, rankings.data.value?.provenance))

useSeo({
  // The words an analyst types ("Anthropic API pricing", "xAI revenue"), not
  // the bare lab name, which matches every page on the web about the lab.
  title: `${display}: API pricing, revenue, hiring, outages`,
  description: `${display} on every axis: API price, SEC revenue, OpenRouter demand share, open roles, status-page incidents, and every alert that cites it.`,
  about: labOrganizationSchema({ name: display, url: LAB_SITE[lab] }),
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
  <TerminalPage :title="display" :as-of="alerts.data.value?.as_of" :error="failed">
    <template #header>
      <dl
        class="grid grid-cols-2 gap-x-6 gap-y-4 rounded border border-default p-3 sm:grid-cols-3 lg:grid-cols-5"
      >
        <TerminalFigure
          v-for="axis in READOUT_AXES"
          :key="axis"
          :label="figures[axis].label"
          :value="figures[axis].value"
          :delta="figures[axis].delta"
          :sub="figures[axis].sub"
          :to="figures[axis].to"
          :source="figures[axis].source"
          :gap="figures[axis].gap"
        />
      </dl>
    </template>

    <TerminalPanel
      id="alerts"
      title="Alerts"
      :note="`Alerts and ticker lines whose cited rows name ${display}, newest first.`"
      :more="
        summary.alerts.length > labAlerts.length
          ? { label: `All ${summary.alerts.length} on the alerts page`, to: '/alerts' }
          : undefined
      "
      :flush="labAlerts.length > 0"
    >
      <TerminalSignalTable v-if="labAlerts.length" :alerts="labAlerts" />
      <TerminalGap v-else title="No alert cites this lab yet." />
    </TerminalPanel>

    <TerminalPanel
      id="prices"
      title="API prices"
      note="$ per million tokens: the like-for-like classes, then every priced SKU on the vendor’s page."
      :more="
        labRows.length > (pricesOf?.rows.length ?? 0)
          ? {
              label: `All ${labRows.length} ${display} SKUs`,
              to: `/prices?provider=${lab}#catalog`,
            }
          : undefined
      "
      flush
    >
      <template v-if="prices.data.value">
        <TerminalPriceMatrix :matrix="prices.data.value.matrix" :providers="[lab]" />
        <div class="border-t border-default p-3">
          <TerminalGap
            v-if="labRows.length === 0"
            title="No SKU rows for this lab yet."
            :action="{ label: 'See coverage', to: '/data#coverage' }"
          />
          <TerminalPriceTable v-else :prices="pricesOf!" bare />
        </div>
      </template>
    </TerminalPanel>

    <div class="grid gap-6 lg:grid-cols-2">
      <TerminalPanel
        id="revenue"
        title="Disclosed revenue"
        note="What the lab, or its public parent, has reported to the SEC."
        :more="{ label: 'Every lab’s revenue', to: '/revenue' }"
      >
        <TerminalRevenuePanel v-if="revenueOf" :revenue="revenueOf" />
      </TerminalPanel>

      <TerminalPanel
        id="releases"
        title="Releases"
        note="SKUs first listed on a tracked page, with the launch price."
        :flush="labReleases.length > 0"
      >
        <TerminalReleaseList v-if="labReleases.length" :rows="labReleases" />
        <TerminalGap v-else title="No new SKU since tracking began." />
      </TerminalPanel>

      <TerminalPanel
        id="demand"
        title="Top models on OpenRouter"
        note="Most-routed models, newest 7 days; the percentage is of this lab’s own tokens. A proxy, not market share."
        :more="{ label: 'Every lab, and the 30-day series', to: '/rankings' }"
      >
        <TerminalRankingsTopModels
          v-if="rankings.data.value?.status === 'ok' && topModels.length"
          :providers="topModels"
        />
        <TerminalGap v-else title="No rankings rows yet." />
      </TerminalPanel>

      <TerminalPanel
        id="spend"
        title="Implied spend share"
        note="This lab’s OpenRouter tokens at its list prices, per model."
      >
        <TerminalSpendShare v-if="spendOf" :spend="spendOf" />
        <TerminalGap v-else title="No rankings rows yet." />
      </TerminalPanel>

      <TerminalPanel
        id="hiring"
        title="Hiring"
        note="Open roles now, the change over the window, and the infrastructure cluster."
        :more="{ label: 'Department mix, buildout, daily series', to: `/hiring#${lab}` }"
        flush
      >
        <TerminalHiringSummary v-if="hiringOf" :history="hiringOf" />
      </TerminalPanel>

      <TerminalPanel
        id="incidents"
        title="Capacity strain"
        :note="
          incidents.data.value
            ? `Status-page incidents, newest ${incidents.data.value.window_days} days against the prior ${incidents.data.value.window_days}.`
            : 'Status-page incidents.'
        "
        :more="
          labIncidents
            ? {
                label: `All ${labIncidents} incidents in ${incidents.data.value?.history_days} days`,
                to: '/incidents',
              }
            : undefined
        "
        flush
      >
        <TerminalStrainTable v-if="incidentsOf" :incidents="incidentsOf" />
      </TerminalPanel>
    </div>
  </TerminalPage>
</template>
