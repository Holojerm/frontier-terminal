<script setup lang="ts">
// One lab across every axis: the readout as figures, the alerts that cite it, then
// each axis panel filtered to the lab. The panels are the same components
// the axis pages render, handed a payload narrowed to one provider, so a
// number here is the same number there — same query, same cache, same
// provenance. The lab is a route parameter; a name outside the tracked labs is a 404.

import { COMPARE_PAIRS, comparePath, pairTitle } from '../../../../shared/utils/terminal-compare'
import { isLab } from '#layers/core/shared/utils/lab-names'
import { summarizeLab, tearSheetPath } from '../../../../shared/utils/terminal-lab-summary'
import { LAB_SITE } from '#layers/core/shared/utils/lab-names'
import type { DataCentersData } from '#layers/compute/shared/utils/compute-views'
import { count } from '#layers/core/shared/utils/terminal-format'
import { labLede } from '../../../../shared/utils/terminal-ledes'
import type { TableColumn } from '#layers/core/app/types/terminal-ui'
import type { ListedData } from '../../../../shared/utils/listed'
import type { ThesesData, ThesisView } from '../../../../shared/utils/thesis-types'
import type {
  AlertsData,
  DisclosuresData,
  GroundTruthData,
  HiringHistoryData,
  IncidentsData,
  PricesData,
  ProbesData,
  RankingsData,
  ReleasesData,
  RevenueData,
  SpendData,
} from '../../../../shared/utils/terminal-types'
import type { LimitsData } from '#layers/pricing/shared/utils/limits'
import type { AdoptionData, ParentsData, PayData } from '../../../../shared/utils/recipe-views'
// Inert for a dynamic route: the collecting hook skips paths with a
// parameter, and sitemap.xml / llms.txt append the lab pages from
// layers/terminal/shared/utils/terminal-lab-summary.ts. Declared anyway — the seo gate's
// invariant is per-page.
definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.9',
    title: 'Lab',
    summary:
      'One frontier lab across everything we track, including flagship API price, disclosed revenue and press reports scored against it, the listed companies tied to it, OpenRouter demand and implied spend share, open roles, the infrastructure buildout, status-page incidents and latency, misalignment disclosures, and the alerts that cite it.',
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
// Where a panel shows only the first few rows, the transform keeps only those
// and records how many there were, so the "All N" links still count the full
// list.
//
// EXPLICIT `key` PER LAB, and it is load-bearing. Nuxt derives an automatic key
// from the call site, not from what a transform closes over — so all the lab
// pages would share one cache entry and a client-side navigation between them
// would render the first lab's rows under the second lab's heading.
const ALERTS_SHOWN = 10
const CATALOG_ROWS = 15
const INCIDENTS_SHOWN = 10
// Releases beside the alerts show as many rows, so neither panel leaves a
// block of empty space under the other; the rest open in place.
const RELEASES_SHOWN = ALERTS_SHOWN
type LabPrices = PricesData & { lab_skus: number }
type LabIncidents = IncidentsData & { incident_count: number }

// No explicit generic on the reshaping fetches: it would pin the data type to
// the response type, which a transform that adds a field cannot satisfy.
const [prices, revenue, rankings, spend, hiring, incidents, releases, alerts] = await Promise.all([
  useFetch('/api/prices', {
    key: `lab-prices:${lab}`,
    transform: (d: PricesData): LabPrices => {
      const rows = d.rows.filter((r) => r.provider === lab)
      return {
        ...d,
        // A readout, not the catalog: priced rows only, a page of them; the
        // rest are on /prices with this lab preselected.
        rows: rows
          .filter((r) => r.input_per_mtok !== null || r.output_per_mtok !== null)
          .slice(0, CATALOG_ROWS),
        lab_skus: rows.length,
      }
    },
  }),
  useFetch<RevenueData>('/api/revenue', {
    key: `lab-revenue:${lab}`,
    transform: (d: RevenueData): RevenueData => ({
      ...d,
      providers: d.providers.filter((p) => p.provider === lab),
    }),
  }),
  useFetch<RankingsData>('/api/rankings', {
    key: `lab-rankings:${lab}`,
    transform: (d: RankingsData): RankingsData => ({
      ...d,
      top_models: d.top_models.filter((m) => m.provider === lab),
    }),
  }),
  useFetch<SpendData>('/api/spend', {
    key: `lab-spend:${lab}`,
    transform: (d: SpendData): SpendData => ({
      ...d,
      providers: d.providers.filter((p) => p.provider === lab),
      excluded: d.excluded.filter((e) => e.provider === lab),
    }),
  }),
  useFetch<HiringHistoryData>('/api/hiring/history', {
    key: `lab-hiring:${lab}`,
    transform: (d: HiringHistoryData): HiringHistoryData => ({
      ...slimArchive(d),
      reach: [],
      providers: slimArchive(d).providers.filter((p) => p.provider === lab),
    }),
  }),
  useFetch('/api/incidents', {
    key: `lab-incidents:${lab}`,
    transform: (d: IncidentsData): LabIncidents => {
      const rows = d.incidents.filter((i) => i.provider === lab)
      return {
        ...d,
        providers: d.providers.filter((p) => p.provider === lab),
        incidents: rows.slice(0, INCIDENTS_SHOWN),
        incident_count: rows.length,
      }
    },
  }),
  useFetch<ReleasesData>('/api/releases', {
    key: `lab-releases:${lab}`,
    transform: (d: ReleasesData): ReleasesData => ({
      ...d,
      rows: d.rows.filter((r) => r.provider === lab),
    }),
  }),
  // Narrowed to the lab on the server (the same any-cited-row predicate as
  // alertLabs), so `total` is the lab's whole history, not its share of the newest 200.
  useFetch<AlertsData>('/api/alerts', {
    key: `lab-alerts:${lab}`,
    query: { tier: 'all', limit: ALERTS_SHOWN, lab },
    // The table prints lab, topic, headline and one figure; see slimAlerts.
    transform: (d: AlertsData): AlertsData => ({ ...d, rows: slimAlerts(d.rows) }),
  }),
])

// The thesis recipes' panels, each narrowed to this lab on the server.
const [adoption, limits, pay, parents, power] = await Promise.all([
  useFetch<AdoptionData>('/api/adoption', {
    key: `lab-adoption:${lab}`,
    transform: (d: AdoptionData): AdoptionData => ({
      ...d,
      downloads: d.downloads.filter((x) => x.lab === lab),
      agent_prs: d.agent_prs.filter((x) => x.lab === lab),
    }),
  }),
  useFetch<LimitsData>('/api/limits', {
    key: `lab-limits:${lab}`,
    transform: (d: LimitsData): LimitsData => ({
      ...d,
      pages: d.pages.filter((p) => p.lab === lab),
    }),
  }),
  useFetch<PayData>('/api/pay', {
    key: `lab-pay:${lab}`,
    transform: (d: PayData): PayData => ({ ...d, boards: d.boards.filter((b) => b.lab === lab) }),
  }),
  useFetch<ParentsData>('/api/parents', {
    key: `lab-parents:${lab}`,
    transform: (d: ParentsData): ParentsData => ({
      ...d,
      parents: d.parents.filter((p) => p.lab === lab),
    }),
  }),
  useFetch<DataCentersData>('/api/datacenters', {
    key: `lab-power:${lab}`,
    transform: (d: DataCentersData): DataCentersData => ({
      ...d,
      labs: d.labs.filter((l) => l.lab === lab),
      // Every tracked site (~13 KB); only /power's site table reads it.
      site_list: [],
    }),
  }),
])
// The fundamentals around the lab: press against filings, the listed companies
// tied to it, measured latency, its disclosures, and the theses that read it.
// Each route narrows to the lab on the server (`?lab=`).
type ThesisLink = Pick<ThesisView, 'id' | 'title' | 'stance' | 'position'> & {
  role: 'subject' | 'compared'
}
const [truth, listed, probes, disclosures, theses] = await Promise.all([
  useFetch<GroundTruthData>('/api/ground-truth', { key: `lab-truth:${lab}`, query: { lab } }),
  useFetch<ListedData>('/api/listed', { key: `lab-listed:${lab}`, query: { lab } }),
  useFetch<ProbesData>('/api/probes', { key: `lab-probes:${lab}`, query: { lab } }),
  useFetch('/api/disclosures', {
    key: `lab-disclosures:${lab}`,
    query: { lab },
    // The summary row only; the entries are on /disclosures.
    transform: ({
      entries: _entries,
      ...rest
    }: DisclosuresData): Omit<DisclosuresData, 'entries'> => rest,
  }),
  useFetch('/api/theses', {
    key: `lab-theses:${lab}`,
    // A thesis about this lab, or one that reads it as a comparison or as one of a group.
    transform: (d: ThesesData): ThesisLink[] =>
      d.theses
        .filter(
          (t) =>
            t.company === lab || t.comparison_set.includes(lab) || t.company === 'frontier-labs',
        )
        .map((t) => ({
          id: t.id,
          title: t.title,
          stance: t.stance,
          position: t.position,
          role: t.company === lab ? 'subject' : 'compared',
        })),
  }),
])
const listedCount = computed(() => listed.data.value?.counts.companies ?? 0)
const thesisLinks = computed(() => theses.data.value ?? [])
const ownTheses = computed(() => thesisLinks.value.filter((t) => t.role === 'subject'))
const comparedIn = computed(() => thesisLinks.value.filter((t) => t.role === 'compared'))

const rampHasLab = computed(
  () => adoption.data.value?.ramp?.series.some((s) => s.lab === lab) ?? false,
)

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
// The header figures once more as sentences, the form an answer engine quotes.
const lede = computed(() => labLede(summary.value) ?? undefined)
const display = summary.value.display
const fmt = useFigures()
const stamps = useStamps()
const figures = computed(() =>
  readoutCells(summary.value, rankings.data.value?.provenance, fmt.usd, stamps.date),
)
// The readout as two groups. Power has no axis of its own, so it joins here
// and nowhere else: under economics, where the site nav files Compute.
const readoutGroups = computed(() =>
  READOUT_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    cells: [
      ...g.axes.map((axis) => figures.value[axis]),
      ...(g.id === 'economics' ? [powerCell(lab, display, power.data.value)] : []),
    ],
  })),
)

useSeo({
  image: ogCardPath(route.path),
  // The words an analyst types ("Anthropic API pricing", "xAI revenue"), not
  // the bare lab name, which matches every page on the web about the lab.
  title: `${display}: API pricing, revenue, hiring, outages`,
  description: `${display} at a glance: API price, SEC revenue against the press, listed companies tied to it, demand, hiring, incidents, and alerts.`,
  about: labOrganizationSchema({ name: display, url: LAB_SITE[lab] }),
  breadcrumb: [{ name: display, path: `/labs/${lab}` }],
  dateModified: alerts.data.value?.as_of,
})

const failed = computed(() =>
  [prices, revenue, rankings, spend, hiring, incidents, releases, alerts].some(
    (r) => r.error.value !== null && r.error.value !== undefined,
  ),
)

// Already the newest ALERTS_SHOWN; the fetch cut them and kept the count.
const labAlerts = computed(() => summary.value.alerts)
const alertCount = computed(() => alerts.data.value?.total ?? 0)

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
// The archived board history, as one line under the live summary.
const archivedHiring = computed(() => {
  const points = hiring.data.value?.providers[0]?.archived ?? []
  if (points.length === 0) return null
  return { copies: points.length, from: stamps.date(points[0]!.at), first: points[0]!.total }
})

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
// Already the page of priced rows the readout shows; `lab_skus` counts them all.
const labSkus = computed(() => prices.data.value?.lab_skus ?? 0)
const topModels = computed(() => rankings.data.value?.top_models ?? [])
const labReleases = computed(() => releases.data.value?.rows ?? [])
const earlierReleases = computed(() => labReleases.value.length - RELEASES_SHOWN)
const labIncidents = computed(() => incidents.data.value?.incident_count ?? 0)
const pairs = COMPARE_PAIRS.filter((pair) => pair.includes(lab))

// The incidents behind the strain count, newest first: already this lab's
// newest INCIDENTS_SHOWN, cut on the server above.
const recentIncidents = computed(() => incidents.data.value?.incidents ?? [])
const incidentColumns: TableColumn[] = [
  { key: 'started', label: 'Started', class: 'whitespace-nowrap font-mono text-xs' },
  { key: 'title', label: 'Incident' },
  { key: 'status', label: 'Status', class: 'whitespace-nowrap font-mono text-xs text-muted' },
  { key: 'source', label: 'Read from' },
]

// The panels answer seven separate questions, so each question is a tab.
// Every tab renders on the server; the panel ids are unchanged, so an old
// anchor (`#revenue`, `#limits`) opens the tab that holds it.
const tabs = computed(() => [
  { value: 'overview', label: 'Overview', badge: alertCount.value || undefined },
  { value: 'prices', label: 'Prices', badge: labSkus.value || undefined },
  { value: 'revenue', label: 'Revenue' },
  { value: 'companies', label: 'Companies', badge: listedCount.value || undefined },
  { value: 'demand', label: 'Demand' },
  { value: 'hiring', label: 'Hiring' },
  { value: 'operations', label: 'Operations', badge: labIncidents.value || undefined },
])
</script>

<template>
  <TerminalPage :title="display" :lede="lede" :as-of="alerts.data.value?.as_of" :error="failed">
    <template #header>
      <UButton
        :to="tearSheetPath(lab)"
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-file-text"
      >
        Tear sheet
      </UButton>
      <p v-if="thesisLinks.length" class="text-sm text-muted">
        <template v-for="t in ownTheses" :key="t.id">
          Thesis:
          <NuxtLink
            :to="`/theses/${t.id}`"
            class="text-default underline underline-offset-2 hover:text-highlighted"
            >{{ t.title }}</NuxtLink
          >
          ({{ t.stance }}, {{ t.position === 'none' ? 'no position' : t.position }}).
        </template>
        <template v-if="comparedIn.length">
          Compared in the
          <template v-for="(t, i) in comparedIn" :key="t.id"
            ><template v-if="i > 0">{{ i === comparedIn.length - 1 ? ' and ' : ', ' }}</template
            ><NuxtLink
              :to="`/theses/${t.id}`"
              class="text-default underline underline-offset-2 hover:text-highlighted"
              >{{ t.title }}</NuxtLink
            ></template
          >
          {{ comparedIn.length === 1 ? 'thesis' : 'theses' }}.
        </template>
      </p>
      <!-- Four economics figures beside two operations figures, in six equal
           columns. Only from 2xl: at xl a column is too narrow for a price
           pair on one line, so the groups stack. -->
      <div class="grid gap-3 2xl:grid-cols-3">
        <section
          v-for="g in readoutGroups"
          :key="g.id"
          :aria-labelledby="`readout-${g.id}`"
          class="min-w-0 space-y-3 rounded border border-default p-3"
          :class="g.cells.length > 2 ? '2xl:col-span-2' : undefined"
        >
          <h2 :id="`readout-${g.id}`" class="text-sm text-highlighted">{{ g.label }}</h2>
          <dl
            class="grid grid-cols-2 gap-x-6 gap-y-4"
            :class="g.cells.length > 2 ? 'lg:grid-cols-4' : undefined"
          >
            <TerminalFigure
              v-for="c in g.cells"
              :key="c.label"
              :label="c.label"
              :value="c.value"
              :delta="c.delta"
              :sub="c.sub"
              :to="c.to"
              :source="c.source"
              :gap="c.gap"
            />
          </dl>
        </section>
      </div>
    </template>

    <TerminalTabs :tabs="tabs">
      <template #overview>
        <div class="grid gap-6 xl:grid-cols-2">
          <TerminalPanel
            id="alerts"
            title="Alerts"
            :note="`Alerts and minor changes whose cited rows name ${display}, newest first.`"
            :more="
              alertCount > labAlerts.length
                ? { label: `All ${alertCount} on the alerts page`, to: `/alerts?lab=${lab}` }
                : undefined
            "
            :flush="labAlerts.length > 0"
          >
            <TerminalSignalTable v-if="labAlerts.length" :alerts="labAlerts" flow scoped />
            <TerminalGap v-else-if="alerts.data.value" title="No alert cites this lab yet." />
            <TerminalGap v-else title="Didn’t load." />
          </TerminalPanel>

          <TerminalPanel
            id="releases"
            title="Releases"
            note="SKUs first listed on a tracked page, with the launch price."
            :flush="labReleases.length > 0"
          >
            <template v-if="labReleases.length">
              <TerminalReleaseList :rows="labReleases.slice(0, RELEASES_SHOWN)" flow />
              <div v-if="earlierReleases > 0" class="border-t border-default px-3">
                <TerminalExpand
                  :show="`Show ${earlierReleases} earlier release${earlierReleases === 1 ? '' : 's'}`"
                  hide="Hide the earlier releases"
                >
                  <TerminalReleaseList :rows="labReleases.slice(RELEASES_SHOWN)" flow />
                </TerminalExpand>
              </div>
            </template>
            <TerminalGap v-else-if="releases.data.value" title="No new SKU since tracking began." />
            <TerminalGap v-else title="Didn’t load." />
          </TerminalPanel>
        </div>

        <TerminalPanel
          id="compare"
          title="Compare"
          :note="`${display} side by side with each other lab.`"
        >
          <ul class="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <li v-for="pair in pairs" :key="comparePath(pair)">
              <NuxtLink
                :to="comparePath(pair)"
                class="py-1.5 text-default underline underline-offset-2 hover:text-highlighted"
                >{{ pairTitle(pair) }}</NuxtLink
              >
            </li>
          </ul>
        </TerminalPanel>
      </template>

      <template #prices>
        <TerminalPanel
          id="prices"
          title="API prices"
          note="$ per million tokens."
          :more="
            labSkus > (prices.data.value?.rows.length ?? 0)
              ? {
                  label: `All ${labSkus} ${display} SKUs`,
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
                v-if="labSkus === 0"
                title="No SKUs for this lab yet."
                :action="{ label: 'See coverage', to: '/data#coverage' }"
              />
              <TerminalPriceTable v-else :prices="prices.data.value" bare />
            </div>
          </template>
        </TerminalPanel>
      </template>

      <template #revenue>
        <div class="grid gap-6">
          <TerminalPanel
            id="revenue"
            title="Disclosed revenue"
            note="What the lab, or its public parent, has reported to the SEC."
            :more="{ label: 'Every lab’s revenue', to: '/revenue' }"
          >
            <TerminalRevenuePanel v-if="revenueOf" :revenue="revenueOf" />
          </TerminalPanel>

          <TerminalGroundTruth v-if="truth.data.value" :truth="truth.data.value" :lab="lab" />
        </div>
      </template>

      <template #companies>
        <div class="grid gap-6">
          <TerminalPanel
            v-if="parents.data.value?.parents.length"
            id="parents"
            title="What its investor discloses"
            note="The investor’s own figures from its newest 10-Q or 10-K. They aren’t the lab’s revenue."
            :more="{ label: 'Every quarter, on Exposure', to: `/exposure#${lab}` }"
          >
            <TerminalParentFacts :parents="parents.data.value" />
          </TerminalPanel>

          <TerminalListed v-if="listedCount" :data="listed.data.value!" :lab="lab" />
          <TerminalGap
            v-else
            :title="`No listed company is tied to ${display} by name yet.`"
            :action="{ label: 'See the graph', to: '/dependencies' }"
          />

          <TerminalPanel
            v-if="power.data.value?.labs.length"
            id="power"
            title="Data-center power"
            note="Epoch AI’s estimate of the sites that name this lab as a user."
            :more="{ label: 'Every lab, and every site', to: '/power' }"
          >
            <TerminalDataCenterPower :data="power.data.value" />
          </TerminalPanel>
        </div>
      </template>

      <template #demand>
        <div class="grid gap-6 lg:grid-cols-2">
          <TerminalPanel
            id="demand"
            title="Top models on OpenRouter"
            note="Most-routed models, last 7 days, as a share of this lab’s OpenRouter tokens."
            :more="{ label: 'Every lab, and the 30-day series', to: '/rankings' }"
          >
            <TerminalRankingsTopModels
              v-if="rankings.data.value?.status === 'ok' && topModels.length"
              :providers="topModels"
            />
            <TerminalGap v-else title="No rankings data yet." />
          </TerminalPanel>

          <TerminalPanel
            id="spend"
            title="Implied spend share"
            note="This lab’s OpenRouter tokens at list price. Share of the tracked labs’ total."
          >
            <TerminalSpendShare v-if="spendOf" :spend="spendOf" />
            <TerminalGap v-else title="No rankings data yet." />
          </TerminalPanel>

          <TerminalPanel
            v-if="rampHasLab"
            id="enterprise"
            title="Enterprise adoption"
            note="Share of US businesses on Ramp paying this lab, monthly, beside any AI vendor."
            :more="{ label: 'Every vendor', to: '/rankings#enterprise' }"
          >
            <TerminalAdoptionRamp
              :ramp="adoption.data.value!.ramp!"
              :caveat="adoption.data.value!.caveats.ramp"
              :labs="[lab]"
            />
          </TerminalPanel>

          <TerminalPanel
            v-if="adoption.data.value?.downloads.length"
            id="downloads"
            title="Downloads"
            note="This lab’s SDKs and coding agent on npm and PyPI, the newest 28 days against the 28 before."
            :more="{ label: 'Every lab’s packages', to: '/rankings#developers' }"
          >
            <TerminalDownloadsTable
              :downloads="adoption.data.value.downloads"
              :caveat="adoption.data.value.caveats.downloads"
            />
          </TerminalPanel>
        </div>
      </template>

      <template #hiring>
        <div class="grid gap-6 lg:grid-cols-2">
          <TerminalPanel
            id="hiring"
            title="Hiring"
            note="Open roles now, the change over the window, and infrastructure roles."
            :more="{ label: 'Department mix, buildout, daily series', to: `/hiring#${lab}` }"
            flush
          >
            <TerminalHiringSummary v-if="hiringOf" :history="hiringOf" />
            <p v-if="archivedHiring" class="px-3 py-2 text-xs text-muted">
              Archived: {{ count(archivedHiring.copies) }} Internet Archive copies from
              <span class="font-mono">{{ archivedHiring.from }}</span>, when the board listed
              {{ count(archivedHiring.first) }} open roles.
              <NuxtLink
                :to="`/hiring#archived-${lab}`"
                class="text-default underline underline-offset-2 hover:text-highlighted"
                >See the archived series</NuxtLink
              >.
            </p>
          </TerminalPanel>

          <TerminalPanel
            v-if="pay.data.value?.boards.length"
            id="pay"
            title="Posted pay"
            note="Median midpoint of the US salary bands on this lab’s job board."
            :more="{ label: 'Hiring', to: '/hiring#pay' }"
          >
            <TerminalPayTable :pay="pay.data.value" />
          </TerminalPanel>
        </div>
      </template>

      <template #operations>
        <!-- Stacked: one lab's strain is one row, and beside the incident list
             it stretched to the list's height. -->
        <div class="grid gap-6">
          <TerminalPanel
            id="incidents"
            title="Capacity strain"
            :note="
              incidents.data.value
                ? `Status-page incidents in the last ${incidents.data.value.window_days} days, against the ${incidents.data.value.window_days} before.`
                : 'Status-page incidents.'
            "
            flush
          >
            <TerminalStrainTable v-if="incidentsOf" :incidents="incidentsOf" />
          </TerminalPanel>

          <TerminalPanel
            v-if="probes.data.value?.labs.length"
            id="probes"
            title="Measured strain"
            :note="`Hourly timed requests to ${display}’s flagship model, working hours against night, last ${probes.data.value.window_days} days.`"
            :more="{ label: 'Every lab, and how we probe', to: '/incidents#probes' }"
            flush
          >
            <TerminalProbeStrain :probes="probes.data.value" />
          </TerminalPanel>

          <TerminalPanel
            v-if="recentIncidents.length"
            id="recent-incidents"
            title="Recent incidents"
            :note="`Newest ${recentIncidents.length} of ${labIncidents} in ${incidents.data.value?.history_days} days, as the vendor posted them.`"
            :more="
              labIncidents > recentIncidents.length
                ? { label: `All ${labIncidents} incidents`, to: '/incidents' }
                : undefined
            "
            flush
          >
            <TerminalTable
              :caption="`${display} status-page incidents, newest first`"
              :columns="incidentColumns"
              :rows="recentIncidents"
              :row-key="(i) => i.entity_key"
              row-header="title"
            >
              <template #cell-started="{ row: i }">
                <time :datetime="i.started_at" :title="i.started_at">
                  {{ stamps.absolute(i.started_at) }}
                </time>
              </template>
              <template #cell-title="{ row: i }">
                <a
                  :href="i.incident_url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-highlighted underline underline-offset-2"
                  >{{ i.title }}</a
                >
              </template>
              <template #cell-status="{ row: i }">
                <UBadge
                  v-if="i.resolved_at === null"
                  color="warning"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-activity"
                >
                  open · {{ i.status }}
                </UBadge>
                <template v-else>{{ i.status }}</template>
              </template>
              <template #cell-source="{ row: i }">
                <TerminalProvenanceTag :source-url="i.source_url" :fetched-at="i.fetched_at" />
              </template>
            </TerminalTable>
          </TerminalPanel>
        </div>

        <TerminalPanel
          v-if="disclosures.data.value?.providers.length"
          id="disclosures"
          title="Misalignment disclosures"
          note="Reports and notices on the lab’s own disclosure index, and the median days from discovery to publication."
          :more="{ label: 'Every report, in the lab’s words', to: '/disclosures' }"
          flush
        >
          <TerminalDisclosureTable :disclosures="disclosures.data.value" />
        </TerminalPanel>

        <TerminalPanel
          v-if="limits.data.value?.pages.length"
          id="limits"
          title="Published rate limits"
          note="As the lab’s docs print them, per model and tier."
          :more="{ label: 'Every lab', to: '/incidents#limits' }"
        >
          <TerminalLimitsTable
            :pages="limits.data.value.pages"
            :caveat="limits.data.value.caveat"
          />
        </TerminalPanel>
      </template>
    </TerminalTabs>
  </TerminalPage>
</template>
