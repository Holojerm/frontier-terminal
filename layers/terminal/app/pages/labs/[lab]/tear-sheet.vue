<script setup lang="ts">
// One lab on one printed page (US Letter or A4). The payloads are the lab page's, each
// narrowed to this lab on the server before it reaches the hydration payload;
// layers/terminal/app/utils/tear-sheet.ts turns them into the sheet.
//
// Print: the layout hides the site header and footer, this page hides its own controls,
// and the sheet resets the colour tokens to black on white so dark mode prints the same as
// light. Links print their short URL beside them.

// Inert for a dynamic route, as on the lab page: sitemap.xml and llms.txt list
// the sheets from TEAR_SHEET_PAGES (terminal-lab-summary.ts).
definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.6',
    title: 'Lab tear sheet',
    summary:
      'One frontier lab on one printable page, with API prices and the last change, disclosed revenue and press reports scored against it, hyperscaler filings and listed companies that name it, OpenRouter demand share, Ramp adoption and package downloads, open roles and posted pay, data-center power, published rate limits, incidents, the newest alerts, and every source with its fetch time.',
  },
})

const route = useRoute()
const labParam = String(route.params.lab ?? '')
if (!isLab(labParam)) {
  throw createError({ statusCode: 404, statusMessage: 'No such lab', fatal: true })
}
const lab = labParam

// Explicit per-lab keys for the reason the lab page gives: an automatic key
// follows the call site, so every lab's sheet would share one entry.
const [prices, revenue, rankings, hiring, incidents, alerts, exposure, theses, truth, listed] =
  await Promise.all([
    useFetch<PricesData>('/api/prices', {
      key: `sheet-prices:${lab}`,
      transform: (d: PricesData): PricesData => ({
        ...d,
        rows: [],
        matrix: { ...d.matrix, cells: d.matrix.cells.filter((c) => c.provider === lab) },
      }),
    }),
    useFetch<RevenueData>('/api/revenue', {
      key: `sheet-revenue:${lab}`,
      transform: (d: RevenueData): RevenueData => ({
        ...d,
        providers: d.providers.filter((p) => p.provider === lab),
      }),
    }),
    useFetch<RankingsData>('/api/rankings', {
      key: `sheet-rankings:${lab}`,
      transform: (d: RankingsData): RankingsData => ({
        ...d,
        shares: d.shares.filter((s) => s.provider === lab),
        top_models: [],
        series: [],
      }),
    }),
    useFetch<HiringHistoryData>('/api/hiring/history', {
      key: `sheet-hiring:${lab}`,
      transform: (d: HiringHistoryData): HiringHistoryData => ({
        ...withoutArchive(d),
        providers: withoutArchive(d).providers.filter((p) => p.provider === lab),
      }),
    }),
    useFetch<IncidentsData>('/api/incidents', {
      key: `sheet-incidents:${lab}`,
      transform: (d: IncidentsData): IncidentsData => ({
        ...d,
        providers: d.providers.filter((p) => p.provider === lab),
        incidents: [],
      }),
    }),
    // The alert tier only (notable and critical), so a week of minor hiring
    // changes can't push the newest alerts out of the window.
    useFetch<AlertsData>('/api/alerts', {
      key: `sheet-alerts:${lab}`,
      query: { tier: 'alert', limit: SHEET_ALERTS, lab },
    }),
    useFetch<ExposureData>('/api/exposure', {
      key: `sheet-exposure:${lab}`,
      transform: (d: ExposureData): ExposureData => ({
        ...d,
        series: d.series.filter((s) => s.group === lab),
        gaps: d.gaps.filter((g) => g.group === lab),
      }),
    }),
    useFetch<ThesesData>('/api/theses', {
      key: `sheet-theses:${lab}`,
      transform: (d: ThesesData): ThesesData => ({
        ...d,
        theses: d.theses.filter((t) => t.company === lab),
      }),
    }),
    // These two take `?lab=`, so the server narrows them.
    useFetch('/api/ground-truth', {
      key: `sheet-truth:${lab}`,
      query: { lab },
      transform: (d: GroundTruthData) => truthInput(d),
    }),
    useFetch<ListedData>('/api/listed', { key: `sheet-listed:${lab}`, query: { lab } }),
  ])

// The recipe-read panels (tear-sheet-recipes.ts), each narrowed to the lab here,
// and slimmed to what the sheet prints: no weekly series, no archived limits, no site list.
const [adoption, pay, limits, datacenters] = await Promise.all([
  useFetch('/api/adoption', {
    key: `sheet-adoption:${lab}`,
    transform: (d: AdoptionData): NonNullable<RecipeInputs['adoption']> => ({
      ramp: d.ramp && {
        ...d.ramp,
        series: d.ramp.series.filter((s) => s.key === 'overall' || s.lab === lab),
      },
      downloads: d.downloads
        .filter((x) => x.lab === lab)
        .map((x) => ({ ...x, weekly: [], normalized: [], share: [] })),
      agent_prs: d.agent_prs
        .filter((x) => x.lab === lab)
        .map((x) => ({ ...x, days: [], weekly: x.weekly.slice(-2) })),
      caveats: d.caveats,
    }),
  }),
  useFetch('/api/pay', {
    key: `sheet-pay:${lab}`,
    transform: (d: PayData): NonNullable<RecipeInputs['pay']> => ({
      boards: d.boards.filter((b) => b.lab === lab),
      caveat: d.caveat,
    }),
  }),
  useFetch('/api/limits', {
    key: `sheet-limits:${lab}`,
    transform: (d: LimitsData): NonNullable<RecipeInputs['limits']> => ({
      pages: d.pages.filter((p) => p.lab === lab).map(({ archived: _archived, ...p }) => p),
      caveat: d.caveat,
    }),
  }),
  useFetch('/api/datacenters', {
    key: `sheet-power:${lab}`,
    transform: (d: DataCentersData): NonNullable<RecipeInputs['datacenters']> => ({
      snapshot: d.snapshot,
      labs: d.labs.filter((l) => l.lab === lab),
      speculative_only: d.speculative_only,
      source: d.source,
      caveat: d.caveat,
    }),
  }),
])

const config = useRuntimeConfig()
const appUrl = config.public.appUrl.replace(/\/+$/, '')
const attribution = attributionLine(config.public.appName, appUrl)
const absolute = (path: string) => `${appUrl}${path}`

const stamps = useStamps()
const sheet = computed(() =>
  buildTearSheet(
    lab,
    {
      prices: prices.data.value,
      revenue: revenue.data.value,
      rankings: rankings.data.value,
      hiring: hiring.data.value,
      incidents: incidents.data.value,
      alerts: alerts.data.value?.rows ?? [],
      exposure: exposure.data.value,
      theses: theses.data.value,
      truth: truth.data.value,
      listed: listed.data.value,
      adoption: adoption.data.value,
      pay: pay.data.value,
      limits: limits.data.value,
      datacenters: datacenters.data.value,
      siteUrl: appUrl,
    },
    stamps.style.value,
  ),
)
const display = sheet.value.display
const asOf = computed(() => prices.data.value?.as_of ?? alerts.data.value?.as_of ?? null)

useSeo({
  image: ogCardPath(route.path),
  title: `${display} tear sheet: prices, revenue, hiring, incidents`,
  description: `${display} on one printable page: API prices, SEC revenue against the press, listed companies, demand and adoption, hiring and pay, power, rate limits, incidents and alerts, each sourced.`,
  about: labOrganizationSchema({ name: display, url: LAB_SITE[lab] }),
  breadcrumb: [
    { name: display, path: labPath(lab) },
    { name: 'Tear sheet', path: tearSheetPath(lab) },
  ],
  dateModified: asOf.value,
})

const failed = computed(() =>
  [
    prices,
    revenue,
    rankings,
    hiring,
    incidents,
    alerts,
    exposure,
    theses,
    truth,
    listed,
    adoption,
    pay,
    limits,
    datacenters,
  ].some((r) => r.error.value !== null && r.error.value !== undefined),
)

const printSheet = () => window.print()

// On paper the sheet is black on white whatever the colour mode: every
// semantic token the sheet reads is pointed at black ink or white paper.
const PRINT_INK = [
  'print:[--ui-text:black]',
  'print:[--ui-text-highlighted:black]',
  'print:[--ui-text-muted:black]',
  'print:[--ui-text-toned:black]',
  'print:[--ui-text-dimmed:black]',
  'print:[--ui-primary:black]',
  'print:[--ui-bg:white]',
  'print:[--ui-bg-muted:white]',
  'print:[--ui-bg-elevated:white]',
  'print:[--ui-border:black]',
  'print:[--ui-border-muted:black]',
  'print:[--ui-border-accented:black]',
  // No print zoom: body type prints at 10.5pt and captions at 9pt. The
  // figures fill the first Letter page; for a lab with every axis populated,
  // the filings, alerts and sources run onto the pages after. Sections never split.
].join(' ')
</script>

<template>
  <div :class="PRINT_INK" class="print:bg-default print:text-default">
    <TerminalPage narrow :error="failed" :as-of="asOf ?? undefined" class="print:max-w-none">
      <template #title>{{ display }} tear sheet</template>
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <p class="text-xs text-muted">
            <template v-if="!asOf">No check yet · </template>$ per million tokens · times
            {{ stamps.zone.value }} ·
            <span class="font-mono">{{ shortUrl(absolute(tearSheetPath(lab))) }}</span>
          </p>
          <div class="flex flex-wrap items-center gap-2 print:hidden">
            <UButton
              :to="labPath(lab)"
              color="neutral"
              variant="ghost"
              size="sm"
              icon="i-lucide-arrow-left"
            >
              {{ display }}
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-printer"
              @click="printSheet"
            >
              Print or save as PDF
            </UButton>
          </div>
        </div>
        <p v-if="sheet.thesis" class="text-xs">
          <NuxtLink :to="sheet.thesis.path" class="text-highlighted underline underline-offset-2"
            >{{ sheet.thesis.title }} thesis</NuxtLink
          ><span class="hidden text-muted print:inline">{{
            ` (${shortUrl(absolute(sheet.thesis.path))})`
          }}</span
          ><span class="text-muted">{{
            `: ${sheet.thesis.stance.toLowerCase()}, ${sheet.thesis.claims} claims, ${sheet.thesis.statuses}.`
          }}</span>
        </p>
      </template>

      <div class="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 print:grid-cols-2 print:gap-y-2">
        <TearSheetSection
          id="prices"
          title="API prices"
          :note="sheet.tierNote"
          class="sm:col-span-2 print:col-span-2"
        >
          <TerminalTable
            v-if="sheet.prices.length"
            :caption="`${display} list prices by class, with the newest change`"
            :columns="[
              { key: 'label', label: 'Class' },
              { key: 'model', label: 'Model', class: 'whitespace-nowrap font-mono' },
              { key: 'input', label: 'In', numeric: true, class: 'font-mono' },
              { key: 'output', label: 'Out', numeric: true, class: 'font-mono' },
              { key: 'change', label: 'Last change' },
            ]"
            :rows="sheet.prices"
            :row-key="(r) => r.class"
            :gap="(r) => r.gap !== null"
            :gap-columns="['input', 'output', 'change']"
            nested
            flow
          >
            <template #cell-model="{ row }">
              <template v-if="row.model">{{ row.model }}<TearSheetRef :n="row.ref" /></template>
              <span v-else class="text-muted">none</span>
            </template>
            <template #gap="{ row }">
              <TearSheetGap :title="row.gap!.title" :reason="row.gap!.reason" />
            </template>
          </TerminalTable>
          <p v-else class="text-xs text-muted">The price matrix didn’t load.</p>
        </TearSheetSection>

        <TearSheetSection id="revenue" title="Disclosed revenue" :note="sheet.revenue.scope">
          <TerminalTable
            v-if="sheet.revenue.lines.length"
            :caption="`${display} revenue as filed with the SEC, newest period first`"
            :columns="[
              { key: 'period', label: 'Period' },
              { key: 'value', label: 'Revenue', numeric: true, class: 'font-mono' },
            ]"
            :rows="sheet.revenue.lines"
            :row-key="(r) => r.key"
            nested
            flow
          >
            <template #cell-value="{ row }">{{ row.value }}<TearSheetRef :n="row.ref" /></template>
          </TerminalTable>
          <p v-else-if="sheet.revenue.gap">
            <TearSheetGap :title="sheet.revenue.gap.title" :reason="sheet.revenue.gap.reason" />
          </p>
        </TearSheetSection>

        <!-- Demand and adoption sit beside revenue with the economics. Hiring and
             incidents are how the lab runs, so they get a section of their own. -->
        <TearSheetSection id="demand" title="Demand">
          <TearSheetFigures :figures="[sheet.demand, ...sheet.adoption]" />
        </TearSheetSection>

        <TearSheetSection
          id="downloads"
          title="Package downloads"
          :note="
            sheet.downloads.rows.length ? 'Last 28 days on record, against the 28 before' : null
          "
          class="sm:col-span-2 print:col-span-2"
        >
          <TerminalTable
            v-if="sheet.downloads.rows.length"
            :caption="`${display} SDK and coding-agent package downloads, last 28 days`"
            :columns="[
              { key: 'package', label: 'Package', class: 'font-mono' },
              { key: 'registry', label: 'Registry' },
              { key: 'kind', label: 'Kind' },
              { key: 'last', label: 'Last 28 days', numeric: true, class: 'font-mono' },
              { key: 'change', label: 'vs prior 28', numeric: true, class: 'font-mono' },
              { key: 'through', label: 'Through', class: 'whitespace-nowrap font-mono' },
            ]"
            :rows="sheet.downloads.rows"
            :row-key="(r) => r.key"
            :gap="(r) => r.last === null"
            :gap-columns="['last', 'change']"
            nested
            flow
          >
            <template #cell-package="{ row }"
              >{{ row.package }}<TearSheetRef :n="row.ref"
            /></template>
            <template #gap>
              <TearSheetGap title="No full 28 days on record" />
            </template>
          </TerminalTable>
          <p v-else-if="sheet.downloads.gap">
            <TearSheetGap :title="sheet.downloads.gap.title" :reason="sheet.downloads.gap.reason" />
          </p>
        </TearSheetSection>

        <TearSheetSection id="operations" title="Operations" class="sm:col-span-2 print:col-span-2">
          <TearSheetFigures :figures="[sheet.hiring, sheet.incidents]" wide />
        </TearSheetSection>

        <TearSheetSection
          id="pay"
          title="Posted pay"
          :note="sheet.pay.rows.length ? 'Median midpoint of posted US salary bands' : null"
          class="sm:col-span-2 print:col-span-2"
        >
          <TerminalTable
            v-if="sheet.pay.rows.length"
            :caption="`${display}’s posted US salary bands, median midpoint per role family`"
            :columns="[
              { key: 'label', label: 'Roles' },
              { key: 'median', label: 'Median midpoint', numeric: true, class: 'font-mono' },
              { key: 'range', label: 'Middle half', numeric: true, class: 'font-mono' },
              { key: 'bands', label: 'Bands', numeric: true, class: 'font-mono' },
              { key: 'change', label: 'Change' },
            ]"
            :rows="sheet.pay.rows"
            :row-key="(r) => r.key"
            nested
            flow
          >
            <template #cell-median="{ row }"
              >{{ row.median }}<TearSheetRef :n="row.ref"
            /></template>
          </TerminalTable>
          <p v-else-if="sheet.pay.gap">
            <TearSheetGap :title="sheet.pay.gap.title" :reason="sheet.pay.gap.reason" />
          </p>
        </TearSheetSection>

        <TearSheetSection id="power" title="Power">
          <TearSheetFigures :figures="[sheet.power]" />
        </TearSheetSection>

        <TearSheetSection id="limits" title="Published rate limits">
          <TerminalTable
            v-if="sheet.limits.rows.length"
            :caption="`${display}’s published rate-limit pages, and when a limit last changed`"
            :columns="[
              { key: 'covers', label: 'Covers' },
              { key: 'limits', label: 'Limits', numeric: true, class: 'font-mono' },
              { key: 'change', label: 'Last change' },
            ]"
            :rows="sheet.limits.rows"
            :row-key="(r) => r.key"
            align="top"
            nested
            flow
          >
            <template #cell-covers="{ row }"
              >{{ row.covers }}<TearSheetRef :n="row.ref"
            /></template>
          </TerminalTable>
          <p v-else-if="sheet.limits.gap">
            <TearSheetGap :title="sheet.limits.gap.title" :reason="sheet.limits.gap.reason" />
          </p>
        </TearSheetSection>

        <TearSheetSection
          id="truth"
          title="Press against filings"
          :note="sheet.truth.lines.length ? 'Each filed figure, and the reports before it' : null"
          class="sm:col-span-2 print:col-span-2"
        >
          <p v-if="sheet.truth.gap">
            <TearSheetGap :title="sheet.truth.gap.title" :reason="sheet.truth.gap.reason" />
          </p>
          <p v-else class="text-xs text-muted">{{ sheet.truth.summary.join(' ') }}</p>
          <TerminalTable
            v-if="sheet.truth.lines.length"
            :caption="`${display} revenue as filed, against the press reports published before the filing`"
            :columns="[
              { key: 'period', label: 'Period' },
              { key: 'filed', label: 'Filed', numeric: true, class: 'font-mono' },
              { key: 'reports', label: 'Reports', numeric: true, class: 'font-mono' },
              { key: 'median', label: 'Median report', numeric: true, class: 'font-mono' },
              { key: 'error', label: 'Off by', numeric: true, class: 'font-mono' },
            ]"
            :rows="sheet.truth.lines"
            :row-key="(r) => r.key"
            nested
            flow
          >
            <template #cell-filed="{ row }">{{ row.filed }}<TearSheetRef :n="row.ref" /></template>
          </TerminalTable>
        </TearSheetSection>

        <TearSheetSection
          id="exposure"
          title="Hyperscaler filings"
          note="Each line is the filer’s own number"
          class="sm:col-span-2 print:col-span-2"
        >
          <TerminalTable
            v-if="sheet.exposure.lines.length"
            :caption="`What public hyperscalers report about ${display}, newest value per line`"
            :columns="[
              { key: 'label', label: 'Line' },
              { key: 'period', label: 'Period', class: 'whitespace-nowrap text-muted' },
              { key: 'value', label: 'As filed', numeric: true, class: 'font-mono' },
            ]"
            :rows="sheet.exposure.lines"
            :row-key="(r) => r.key"
            nested
            flow
          >
            <template #cell-value="{ row }">{{ row.value }}<TearSheetRef :n="row.ref" /></template>
          </TerminalTable>
          <p v-for="g in sheet.exposure.gaps" :key="g.title">
            <TearSheetGap :title="g.title" :reason="g.reason" />
          </p>
          <p
            v-if="!sheet.exposure.lines.length && !sheet.exposure.gaps.length"
            class="text-xs text-muted"
          >
            None of the {{ sheet.exposure.filers || 'hyperscaler' }} filers we read tags a line on
            {{ display }}.
          </p>
        </TearSheetSection>

        <TearSheetSection
          id="listed"
          title="Listed companies"
          :note="
            sheet.listed.rows.length
              ? 'What a filing or a cited page says ties each one to the lab'
              : null
          "
          class="sm:col-span-2 print:col-span-2"
        >
          <template v-if="sheet.listed.rows.length">
            <TerminalTable
              :caption="`Listed companies a filing or a cited page ties to ${display}`"
              :columns="[
                { key: 'ticker', label: 'Ticker', class: 'font-mono' },
                { key: 'company', label: 'Company' },
                { key: 'group', label: 'What it is' },
                { key: 'ties', label: 'What ties it to a lab' },
              ]"
              :rows="sheet.listed.rows"
              :row-key="(r) => r.ticker"
              align="top"
              nested
              flow
            />
            <p class="text-xs text-muted">
              The figures and quotes behind each tie are on the Dependencies page<TearSheetRef
                :n="sheet.listed.ref"
              />. Not investment advice.
            </p>
          </template>
          <p v-else-if="sheet.listed.gap">
            <TearSheetGap :title="sheet.listed.gap.title" :reason="sheet.listed.gap.reason" />
          </p>
        </TearSheetSection>

        <TearSheetSection
          id="alerts"
          title="Newest alerts"
          note="Notable and critical, newest first"
          class="sm:col-span-2 print:col-span-2"
        >
          <TerminalTable
            v-if="sheet.alerts.length"
            :caption="`The newest notable or critical alerts that cite ${display}`"
            :columns="[
              { key: 'date', label: 'Date', class: 'whitespace-nowrap font-mono' },
              { key: 'severity', label: 'Severity', class: 'capitalize' },
              { key: 'headline', label: 'Alert' },
            ]"
            :rows="sheet.alerts"
            :row-key="(r) => r.id"
            row-header="headline"
            nested
            flow
          >
            <template #cell-headline="{ row }">
              <NuxtLink
                :to="alertPath(row.id)"
                class="text-highlighted underline underline-offset-2"
                >{{ readableEdgarNames(row.headline) }}</NuxtLink
              ><TearSheetRef :n="row.ref" /><span class="hidden text-muted print:inline">{{
                ` ${shortUrl(appUrl)}${alertPath(row.id).slice(0, 16)}…`
              }}</span>
            </template>
          </TerminalTable>
          <p v-else class="text-xs text-muted">No notable or critical alert cites {{ display }}.</p>
        </TearSheetSection>
      </div>

      <footer
        class="space-y-1 border-t border-default pt-2 text-xs text-muted print:break-inside-avoid"
      >
        <h2 class="text-xs text-highlighted">Sources (fetch times {{ stamps.zone.value }})</h2>
        <ol v-if="sheet.sources.length">
          <li v-for="s in sheet.sources" :id="`source-${s.n}`" :key="s.n">
            <span class="font-mono">{{ s.n }}.</span> {{ s.label }} ·
            <a
              :href="s.url"
              target="_blank"
              rel="noopener noreferrer"
              :title="s.url"
              class="break-all underline underline-offset-2"
              >{{ shortUrl(s.url, 44) }}</a
            >
            ·
            <time :datetime="s.fetched_at" :title="s.fetched_at" class="font-mono">{{
              stamps.dated(s.fetched_at)
            }}</time>
          </li>
        </ol>
        <p v-else>No source loaded.</p>
        <p v-for="c in sheet.citations" :key="c">{{ c }}</p>
        <p v-for="c in sheet.caveats" :key="c.label">
          <span class="text-highlighted">{{ c.label }}:</span> {{ c.text }}
        </p>
        <p>
          {{ attribution }} That covers the last {{ LICENSE_WINDOW_DAYS }} days. Older data is
          {{ HISTORY_LICENSE.short }} unless we published it before {{ LICENSE_SPLIT_EFFECTIVE }}.
          The facts belong to their publishers.
        </p>
        <p class="text-highlighted">
          This isn’t investment advice. We report what public sources say and when they said it.
        </p>
      </footer>
    </TerminalPage>
  </div>
</template>
