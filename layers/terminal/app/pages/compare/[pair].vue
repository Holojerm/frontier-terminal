<script setup lang="ts">
// Two labs on every axis, side by side: the readout rows, then each axis
// panel handed a payload narrowed to the pair — the same components, queries
// and cache the axis pages and lab pages read, so a number here is the number
// there. The pair is a route parameter in LABS order; the reverse spelling
// redirects to it, and anything else is a 404.

import { alertLabs, LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import { comparePath, pairTitle, parsePair } from '../../../shared/utils/terminal-compare'
import { labPath } from '../../../shared/utils/terminal-lab-summary'
import type {
  AlertsData,
  HiringHistoryData,
  IncidentsData,
  PricesData,
  RankingsData,
  RevenueData,
} from '../../../shared/utils/terminal-types'

// Inert for a dynamic route: sitemap.xml and llms.txt append the compare
// pages from layers/terminal/shared/utils/terminal-compare.ts. Declared anyway — the seo
// gate's invariant is per-page.
definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.7',
    title: 'Compare',
    summary:
      'Two frontier labs side by side: flagship API price, disclosed SEC revenue, OpenRouter demand share, open roles and the infrastructure buildout, and status-page incidents.',
  },
})

const route = useRoute()
const parsed = parsePair(String(route.params.pair ?? ''))
if (!parsed) {
  throw createError({ statusCode: 404, statusMessage: 'No such comparison', fatal: true })
}
if (!parsed.canonical) {
  await navigateTo(comparePath(parsed.pair), { redirectCode: 301 })
}
const pair = parsed.pair
const [a, b] = pair
const inPair = (provider: string) => (pair as readonly string[]).includes(provider)
const title = pairTitle(pair)
const key = `${a}-${b}`

// Narrowed in `transform`, on the server, so the other labs' rows never reach
// the hydration payload; the shapes are unchanged. The explicit per-pair key
// is load-bearing for the reason labs/[lab].vue gives: an automatic key is
// per call site, so two compare pages would share one cache entry.
const [prices, revenue, rankings, hiring, incidents, alerts] = await Promise.all([
  useFetch('/api/prices', {
    key: `compare-prices:${key}`,
    transform: ({ as_of, computed_at, matrix }: PricesData) => ({ as_of, computed_at, matrix }),
  }),
  useFetch<RevenueData>('/api/revenue', {
    key: `compare-revenue:${key}`,
    transform: (d: RevenueData): RevenueData => ({
      ...d,
      providers: d.providers.filter((p) => inPair(p.provider)),
    }),
  }),
  useFetch<RankingsData>('/api/rankings', {
    key: `compare-rankings:${key}`,
    transform: (d: RankingsData): RankingsData => ({
      ...d,
      shares: d.shares.filter((s) => inPair(s.provider)),
      top_models: d.top_models.filter((m) => inPair(m.provider)),
      series: [],
    }),
  }),
  useFetch<HiringHistoryData>('/api/hiring/history', {
    key: `compare-hiring:${key}`,
    transform: (d: HiringHistoryData): HiringHistoryData => ({
      ...d,
      providers: d.providers.filter((p) => inPair(p.provider)),
    }),
  }),
  useFetch('/api/incidents', {
    key: `compare-incidents:${key}`,
    transform: ({
      incidents: _rows,
      ...rest
    }: IncidentsData): Omit<IncidentsData, 'incidents'> => ({
      ...rest,
      providers: rest.providers.filter((p) => inPair(p.provider)),
    }),
  }),
  useFetch<AlertsData>('/api/alerts', {
    key: `compare-alerts:${key}`,
    query: { tier: 'all', limit: 200 },
    // The readout shows each lab's newest alert and nothing else, so that is
    // all that is kept: two rows, not the ~600KB page.
    transform: (d: AlertsData): AlertsData => ({
      ...d,
      rows: [...new Set(pair.map((lab) => d.rows.find((r) => alertLabs(r).includes(lab))))].filter(
        (r) => r !== undefined,
      ),
    }),
  }),
])

useSeo({
  title: `${title}: API pricing, revenue, hiring`,
  description: `${title}: flagship API price, SEC revenue, OpenRouter demand share, open roles, and status-page incidents, each sourced.`,
  breadcrumb: [{ name: title, path: comparePath(pair) }],
  dateModified: alerts.data.value?.as_of,
})

const failed = computed(() =>
  [prices, revenue, rankings, hiring, incidents, alerts].some(
    (r) => r.error.value !== null && r.error.value !== undefined,
  ),
)

// The lab page's tabs, in its order, so the two read the same way. The
// readout above them stays visible on every tab.
const tabs = [
  { value: 'prices', label: 'Prices' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'demand', label: 'Demand' },
  { value: 'hiring', label: 'Hiring' },
  { value: 'operations', label: 'Operations' },
]

const readout = computed(() => ({
  prices: prices.data.value,
  revenue: revenue.data.value,
  rankings: rankings.data.value,
  hiring: hiring.data.value,
  incidents: incidents.data.value,
  alerts: alerts.data.value?.rows ?? [],
}))
</script>

<template>
  <TerminalPage
    :title="title"
    :lede="`${LAB_DISPLAY[a]} and ${LAB_DISPLAY[b]} side by side on everything we track. Each lab’s own page has the full detail.`"
    :as-of="alerts.data.value?.as_of"
    :error="failed"
  >
    <TerminalPanel
      id="readout"
      title="Readout"
      note="Both labs at a glance. Every figure links to the lab’s page, which cites its source."
      flush
    >
      <TerminalReadoutStrip :labs="pair" :data="readout" />
    </TerminalPanel>

    <TerminalTabs :tabs="tabs">
      <template #prices>
        <TerminalPanel
          id="prices"
          title="API prices"
          note="$ per million tokens, like for like on each vendor’s own recommendation."
          :more="{ label: 'Every SKU, both labs', to: '/prices' }"
          flush
        >
          <TerminalPriceMatrix
            v-if="prices.data.value"
            :matrix="prices.data.value.matrix"
            :providers="[a, b]"
          />
        </TerminalPanel>
      </template>

      <template #revenue>
        <TerminalPanel
          id="revenue"
          title="Disclosed revenue"
          note="What each lab, or its public parent, has reported to the SEC."
          :more="{ label: 'Every lab’s revenue', to: '/revenue' }"
        >
          <TerminalRevenuePanel v-if="revenue.data.value" :revenue="revenue.data.value" />
        </TerminalPanel>
      </template>

      <template #demand>
        <TerminalPanel
          id="demand"
          title="Demand share"
          note="Share of OpenRouter tokens over the last 7 days. It’s one aggregator’s traffic, so treat it as a rough read on demand."
          :more="{ label: 'Every lab, and the 30-day series', to: '/rankings' }"
        >
          <TerminalDemandShare v-if="rankings.data.value" :rankings="rankings.data.value" compact />
        </TerminalPanel>
      </template>

      <template #hiring>
        <TerminalPanel
          id="hiring"
          title="Hiring"
          note="Open roles now, the change over the window, and the department that moved most."
          :more="{ label: 'Department mix and roles per day', to: '/hiring' }"
          flush
        >
          <TerminalHiringSummary v-if="hiring.data.value" :history="hiring.data.value" />
        </TerminalPanel>

        <TerminalPanel
          id="buildout"
          title="Infrastructure buildout"
          note="Open roles in physical-infrastructure departments, added up across each board’s department names."
        >
          <TerminalBuildoutPanel v-if="hiring.data.value" :history="hiring.data.value" />
        </TerminalPanel>
      </template>

      <template #operations>
        <TerminalPanel
          id="incidents"
          title="Capacity strain"
          :note="
            incidents.data.value
              ? `Status-page incidents in the last ${incidents.data.value.window_days} days, against the ${incidents.data.value.window_days} before.`
              : 'Status-page incidents.'
          "
          :more="{ label: 'Every incident', to: '/incidents' }"
          flush
        >
          <TerminalStrainTable v-if="incidents.data.value" :incidents="incidents.data.value" />
        </TerminalPanel>
      </template>
    </TerminalTabs>

    <p class="text-sm text-muted">
      Each lab in full:
      <NuxtLink
        :to="labPath(a)"
        class="text-default underline underline-offset-2 hover:text-highlighted"
        >{{ LAB_DISPLAY[a] }}</NuxtLink
      >,
      <NuxtLink
        :to="labPath(b)"
        class="text-default underline underline-offset-2 hover:text-highlighted"
        >{{ LAB_DISPLAY[b] }}</NuxtLink
      >.
    </p>
  </TerminalPage>
</template>
