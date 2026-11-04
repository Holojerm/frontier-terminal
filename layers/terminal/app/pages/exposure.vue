<script setup lang="ts">
// The hyperscalers the labs run on and are funded by, from their own XBRL:
// capex and backlog for Microsoft, Alphabet, Amazon, Meta and Oracle, and
// what Microsoft tags on OpenAI and Amazon on Anthropic. Quarterly from 2020,
// every value linked to its filing. Every number is the filer's.

import type {
  ExposureData,
  ExposureGroup,
  ExposureSeries,
} from '../../shared/utils/terminal-exposure'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Exposure',
    summary:
      'Quarterly capex and remaining performance obligations for Microsoft, Alphabet, Amazon, Meta, and Oracle since 2020, and every figure Microsoft tags on OpenAI and Amazon on Anthropic, read from each filing’s XBRL with the filing linked. The filer’s numbers, never the lab’s.',
  },
})

const { data, error } = await useFetch<ExposureData>('/api/exposure')

const site = useSiteContext()

useSeo({
  title: 'Hyperscaler capex, backlog, and AI lab stakes',
  description:
    'Quarterly capex and backlog for five hyperscalers since 2020, and what Microsoft and Amazon report about OpenAI and Anthropic, from SEC filings.',
  dateModified: data.value?.as_of,
  schema: [
    datasetSchema(site, {
      url: usePageUrl(),
      name: 'Hyperscaler capex, backlog, and AI lab stakes from SEC filings',
      description:
        'Quarterly capex and remaining performance obligations for five hyperscalers since 2020, and the figures Microsoft and Amazon tag on OpenAI and Anthropic, each value with the filing it came from.',
      dateModified: data.value?.as_of,
      variableMeasured: ['value', 'start', 'end', 'accession_no', 'filed'],
      distribution: exportDistribution(site, 'exposure_quarters'),
    }),
  ],
})

const ORDER = ['MSFT', 'GOOGL', 'AMZN', 'META', 'ORCL']

/** The series of one group, one entry per chart, in filer order. */
function charts(group: ExposureGroup): { id: string; series: ExposureSeries[] }[] {
  const out = new Map<string, ExposureSeries[]>()
  for (const s of data.value?.series ?? []) {
    if (s.group !== group) continue
    out.set(s.chart, [...(out.get(s.chart) ?? []), s])
  }
  return [...out.entries()]
    .map(([id, series]) => ({ id, series }))
    .sort((a, b) => ORDER.indexOf(a.series[0]!.ticker) - ORDER.indexOf(b.series[0]!.ticker))
}

const capex = computed(() => charts('capex'))
const rpo = computed(() => charts('rpo'))

const OPENAI_CHART = 'us-gaap:NonoperatingIncomeExpense'
const openai = computed(() => (data.value?.series ?? []).filter((s) => s.group === 'openai'))
const openaiChart = computed(() => openai.value.filter((s) => s.concept === OPENAI_CHART))
const openaiFacts = computed(() => openai.value.filter((s) => s.concept !== OPENAI_CHART))
const anthropic = computed(() => (data.value?.series ?? []).filter((s) => s.group === 'anthropic'))
const gaps = (group: ExposureGroup) => (data.value?.gaps ?? []).filter((g) => g.group === group)

const titleOf = (series: ExposureSeries[]) => {
  const s = series[0]!
  return s.group === 'capex' ? `${s.filer} capex` : `${s.filer} backlog`
}

const filerLine = computed(() =>
  (data.value?.filers ?? [])
    .map((f) => `${f.name} (CIK ${f.cik}, fiscal year ends ${f.fiscal_year_end})`)
    .join(', '),
)
</script>

<template>
  <TerminalPage
    title="Exposure"
    lede="What the hyperscalers spend and have sold forward, and what Microsoft and Amazon report about OpenAI and Anthropic. Quarterly from 2020, read from XBRL (the SEC’s tagged financial data) in each filing."
    :as-of="data?.as_of"
    :error="Boolean(error)"
    error-title="Exposure didn’t load"
    error-body="Try reloading in a minute."
  >
    <template v-if="data">
      <TerminalPanel
        id="capex"
        title="Capex per quarter"
        note="The cash each company spent on property and equipment. A quarter the filing tags only year to date is that figure less the one a quarter shorter, marked derived."
      >
        <div class="grid gap-3 lg:grid-cols-2">
          <TerminalExposureCard
            v-for="c in capex"
            :id="`chart-${c.id}`"
            :key="c.id"
            :title="titleOf(c.series)"
            :series="c.series"
          />
        </div>
      </TerminalPanel>

      <TerminalPanel
        id="backlog"
        title="Backlog"
        note="Remaining performance obligations at each quarter end: contracted revenue not yet recognized. Cloud figures where the filer tags one."
      >
        <div class="grid gap-3 lg:grid-cols-2">
          <TerminalExposureCard
            v-for="c in rpo"
            :id="`chart-${c.id}`"
            :key="c.id"
            :title="titleOf(c.series)"
            :series="c.series"
          />
        </div>
        <TerminalGap v-for="g in gaps('rpo')" :key="g.id" :title="g.title" :reason="g.reason" />
      </TerminalPanel>

      <TerminalPanel
        id="openai"
        title="Microsoft on OpenAI"
        note="Every figure Microsoft tags on OpenAI in its 10-Q and 10-K, from the first filing that tags it. These are Microsoft’s numbers. They aren’t OpenAI’s results."
      >
        <TerminalExposureCard
          v-if="openaiChart.length"
          id="chart-msft-openai"
          title="Gain or loss Microsoft recognized on OpenAI"
          :series="openaiChart"
        />
        <TerminalExposureFacts
          v-if="openaiFacts.length"
          id="facts-msft-openai"
          title="Microsoft’s other OpenAI figures"
          :series="openaiFacts"
        />
        <TerminalGap
          v-if="!openai.length"
          title="Nothing read yet"
          reason="We read Microsoft’s filings every 30 minutes. The figures show up after the next read."
        />
      </TerminalPanel>

      <TerminalPanel
        id="anthropic"
        title="Amazon on Anthropic"
        note="Every figure Amazon tags on Anthropic, from the first filing that tags it. Amazon’s marks follow prices for its preferred stock and aren’t Anthropic’s valuation."
      >
        <TerminalExposureFacts
          v-if="anthropic.length"
          id="facts-amzn-anthropic"
          title="Amazon’s Anthropic figures"
          :series="anthropic"
        />
        <TerminalGap
          v-for="g in gaps('anthropic')"
          :key="g.id"
          :title="g.title"
          :reason="g.reason"
        />
      </TerminalPanel>

      <TerminalPanel
        id="how"
        title="How we read these"
        note="Where each number comes from, and what it isn’t."
      >
        <div class="max-w-2xl space-y-3 text-sm text-default">
          <p>
            We read {{ filerLine }}. EDGAR’s company facts list each company-wide figure with the
            filing that reported it, back past 2020. A figure tagged on a segment, a customer, or an
            investee is only in each 10-Q and 10-K’s own XBRL file, so we read that file once per
            filing.
          </p>
          <p>
            Each period shows the newest filing’s value. When a later filing restates a value, the
            old one stays in the table as restated. Every row links to its filing.
          </p>
          <p>
            A new 10-Q or 10-K that moves a series raises an alert that states the number. The data
            is at
            <NuxtLink to="/export/exposure_quarters.csv" external class="text-primary underline"
              >exposure_quarters</NuxtLink
            >
            and
            <NuxtLink to="/export/filed_facts.csv" external class="text-primary underline"
              >filed_facts</NuxtLink
            >. Add <code>?as_of=</code> to see only what was filed before a date.
          </p>
        </div>
      </TerminalPanel>
    </template>
  </TerminalPage>
</template>
