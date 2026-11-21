<script setup lang="ts">
// Two labs on every axis, side by side: the readout rows, then each axis panel handed a
// payload narrowed to the pair. Same components, queries and cache as the axis pages and
// lab pages, so a number here is the number there. The pair is a route parameter in LABS
// order; the reverse spelling redirects to it, and anything else is a 404.

// Inert for a dynamic route: sitemap.xml and llms.txt append the compare pages from
// layers/terminal/shared/utils/terminal-compare.ts. Declared anyway: the seo gate's
// invariant is per-page.
definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.7',
    title: 'Compare',
    summary:
      'Two frontier labs side by side: flagship API price, disclosed SEC revenue and press reports scored against it, the listed companies tied to both, OpenRouter demand share, open roles and the infrastructure buildout, status-page incidents, and measured latency.',
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

/** What the press-against-filings table reads: the tally, and the newest filing it scored against. */
const truthRow = (lab: LabId) => (d: GroundTruthData) => ({
  lab,
  tally: d.tally,
  filed: d.resolutions[0]?.filed ?? null,
})

// The fundamentals routes take `?lab=`, so each lab is its own small read.
// Probes are one row per lab, so the pair is kept in a transform. Started
// before the axis reads below are awaited, so all eleven run at once.
const fundamentalsFetch = Promise.all([
  useFetch('/api/ground-truth', {
    key: `compare-truth:${a}`,
    query: { lab: a },
    transform: truthRow(a),
  }),
  useFetch('/api/ground-truth', {
    key: `compare-truth:${b}`,
    query: { lab: b },
    transform: truthRow(b),
  }),
  useFetch<ListedData>('/api/listed', { key: `compare-listed:${a}`, query: { lab: a } }),
  useFetch<ListedData>('/api/listed', { key: `compare-listed:${b}`, query: { lab: b } }),
  useFetch<ProbesData>('/api/probes', {
    key: `compare-probes:${key}`,
    transform: (d: ProbesData): ProbesData => ({
      ...d,
      labs: d.labs.filter((l) => inPair(l.lab)),
    }),
  }),
])

// Narrowed in `transform`, on the server, so the other labs' rows never reach the
// hydration payload; the shapes are unchanged. The explicit per-pair key is needed for the
// reason labs/[lab]/index.vue gives: an automatic key is per call site, so two compare
// pages would share one cache entry.
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
      ...withoutArchive(d),
      providers: withoutArchive(d).providers.filter((p) => inPair(p.provider)),
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
const [truthA, truthB, listedA, listedB, probes] = await fundamentalsFetch

useSeo({
  image: ogCardPath(comparePath(pair)),
  title: `${title}: API pricing, revenue, hiring`,
  description: `${title}: API price, SEC revenue against the press, listed companies tied to both, demand, hiring, incidents and latency, each sourced.`,
  breadcrumb: [{ name: title, path: comparePath(pair) }],
  dateModified: alerts.data.value?.as_of,
})

const failed = computed(() =>
  [
    prices,
    revenue,
    rankings,
    hiring,
    incidents,
    alerts,
    truthA,
    truthB,
    listedA,
    listedB,
    probes,
  ].some((r) => r.error.value !== null && r.error.value !== undefined),
)

const both = computed(() =>
  listedA.data.value && listedB.data.value
    ? listedBoth(listedA.data.value, listedB.data.value)
    : null,
)

const truthRows = computed(() =>
  [truthA.data.value, truthB.data.value]
    .filter((t) => t !== undefined && t !== null)
    .map((t) => ({
      lab: t.lab,
      display: LAB_DISPLAY[t.lab],
      scored: t.tally.reports,
      periods: t.tally.periods,
      error: t.tally.median_abs_error_pct === null ? '' : percent(t.tally.median_abs_error_pct),
      lead: t.tally.median_lead_days === null ? '' : `${t.tally.median_lead_days}`,
      filed: t.filed,
    })),
)
const truthColumns: TableColumn[] = [
  { key: 'display', label: 'Lab' },
  { key: 'scored', label: 'Reports scored', numeric: true },
  { key: 'periods', label: 'Filed figures', numeric: true },
  { key: 'error', label: 'Median report off by', numeric: true },
  { key: 'lead', label: 'First report before filing', hint: 'median days', numeric: true },
  { key: 'source', label: 'Newest filing', keep: true },
]

// The lab page's tabs, in its order, so the two read the same way. The
// readout above them stays visible on every tab.
const tabs = computed(() => [
  { value: 'prices', label: 'Prices' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'companies', label: 'Companies', badge: both.value?.counts.companies || undefined },
  { value: 'demand', label: 'Demand' },
  { value: 'hiring', label: 'Hiring' },
  { value: 'operations', label: 'Operations' },
])

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
    :lede="`${LAB_DISPLAY[a]} and ${LAB_DISPLAY[b]} side by side on everything we track.`"
    :as-of="alerts.data.value?.as_of"
    :error="failed"
  >
    <TerminalPanel id="readout" title="Readout" note="Both labs at a glance." flush>
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

        <TerminalPanel
          id="truth"
          title="Press against filings"
          note="Press reports of each lab’s revenue published before a filing printed the figure, scored against it."
          :more="{ label: 'Every report and filing', to: '/ground-truth' }"
          flush
        >
          <TerminalTable
            caption="Press reports of each lab’s revenue against the filed figure"
            :columns="truthColumns"
            :rows="truthRows"
            :row-key="(r) => r.lab"
            :gap="(r) => r.scored === 0"
          >
            <template #cell-source="{ row }">
              <TerminalProvenanceTag
                v-if="row.filed"
                :label="row.filed.form"
                :source-url="row.filed.source_url"
                :fetched-at="row.filed.fetched_at"
              />
            </template>
            <template #gap>
              <TerminalGap
                inline
                title="No report scored yet"
                reason="No filing has printed a revenue figure the press reported first."
              />
            </template>
          </TerminalTable>
        </TerminalPanel>
      </template>

      <template #companies>
        <TerminalListed v-if="both?.counts.companies" :data="both" :lab="pair" />
        <TerminalGap
          v-else
          :title="`No listed company is tied to both ${LAB_DISPLAY[a]} and ${LAB_DISPLAY[b]} by name yet.`"
          :action="{ label: 'See the graph', to: '/dependencies' }"
        />
      </template>

      <template #demand>
        <TerminalPanel
          id="demand"
          title="Demand share"
          note="Share of OpenRouter tokens, last 7 days."
          :more="{ label: 'Every lab, and the 30-day series', to: '/rankings' }"
        >
          <TerminalDemandShare v-if="rankings.data.value" :rankings="rankings.data.value" />
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
          note="Open roles in physical-infrastructure departments."
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

        <TerminalPanel
          v-if="probes.data.value?.labs.length"
          id="probes"
          title="Measured strain"
          :note="`Hourly timed requests to each lab’s flagship model, working hours against night, last ${probes.data.value.window_days} days.`"
          :more="{ label: 'Every lab, and how we probe', to: '/incidents#probes' }"
          flush
        >
          <TerminalProbeStrain :probes="probes.data.value" />
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
