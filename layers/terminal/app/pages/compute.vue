<script setup lang="ts">
// The compute axis: what renting a GPU costs, how full the capacity looks
// from outside, how much data-center power is coming online and for whom,
// and who supplies it. All read the thesis recipes (GPU price pages, SEC
// filings, MLPerf results and Epoch AI's datasets) except the power suppliers,
// which are read from filings and pages (layers/terminal/shared/utils/power-sites.ts), and the
// grid load where the sites are (EIA-930 and ERCOT, layers/terminal/shared/utils/grid-load.ts). Every
// figure has its source and fetch time. No tabs; the site list is the page's
// long table and runs with the page rather than in a box.

import { count } from '../../shared/utils/terminal-format'
import type { GridLoadData } from '../../shared/utils/grid-load'
import type { PowerSitesData } from '../../shared/utils/power-sites'
import type { DataCentersData, UtilizationData } from '../../shared/utils/recipe-views'
import type { GpuPricesData } from '../../shared/utils/terminal-types'
import type { TableColumn } from '../types/terminal-ui'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Compute',
    summary:
      'On-demand H100 and B200 rental list prices from ten first-party provider pages with the median across them, spot prices against on-demand per provider, both charted on each day a provider’s page changed, the weekly median back to 2023 from the Internet Archive’s copies of those pages, Alphabet’s stated token volume as a bounded share of Google’s estimated fleet, MLPerf Inference tokens per second per accelerator in each round we hold, CoreWeave’s revenue per megawatt of active power, Epoch AI’s estimate of data-center power per frontier lab and per site, the utilities, generators and equipment makers tied to each lab’s sites, average demand on each grid that holds a lab site against a year before (EIA-930), and the large load ERCOT has approved to energize, each with its source page.',
  },
})

const [
  { data: gpu, error },
  { data: power },
  { data: utilization },
  { data: suppliers },
  { data: grid },
] = await Promise.all([
  useFetch<GpuPricesData>('/api/gpu-prices'),
  useFetch<DataCentersData>('/api/datacenters'),
  useFetch<UtilizationData>('/api/utilization'),
  useFetch<PowerSitesData>('/api/power-sites'),
  useFetch<GridLoadData>('/api/grid-load'),
])

useSeo({
  title: 'GPU rental prices, utilization bounds, and AI data-center power',
  description:
    'H100 and B200 rental prices and spot prices from provider pages, bounds on the load Google’s token volume implies, and data-center power per lab.',
  dateModified: gpu.value?.as_of,
})

const stamps = useStamps()

// The pages behind the price series: each provider once, at its newest read.
const gpuSources = computed(() => {
  const pages = new Map<string, { label: string; source_url: string; fetched_at: string }>()
  for (const m of gpu.value?.medians ?? []) {
    for (const p of m.providers) {
      pages.set(p.provider, {
        label: p.provider_name,
        source_url: p.source_url,
        fetched_at: p.fetched_at,
      })
    }
  }
  return [...pages.values()]
})

const siteColumns: TableColumn[] = [
  { key: 'name', label: 'Site' },
  { key: 'power', label: 'Power', numeric: true },
  { key: 'h100', label: 'H100e', numeric: true },
  { key: 'owner', label: 'Owner' },
  { key: 'users', label: 'Users' },
  { key: 'country', label: 'Country' },
]
const sites = computed(() =>
  (power.value?.site_list ?? []).map((s) => ({
    ...s,
    power: `${count(Math.round(s.mw))} MW`,
    h100: s.h100e === null ? '—' : count(Math.round(s.h100e)),
  })),
)
</script>

<template>
  <TerminalPage
    title="Compute"
    lede="What a GPU-hour rents for, how full the capacity looks from public data, and how much data-center power each lab is bringing online."
    :as-of="gpu?.as_of"
    :error="Boolean(error)"
    error-title="GPU prices didn’t load"
    error-body="Try reloading in a minute."
  >
    <TerminalPanel
      v-if="gpu"
      id="gpu"
      title="GPU rental prices"
      note="On-demand list price per GPU-hour, from each provider’s own page."
      :more="{ label: 'The Compute thesis', to: '/theses/compute' }"
    >
      <TerminalGpuMedians :gpu="gpu" />
    </TerminalPanel>

    <template v-if="utilization">
      <TerminalPanel
        id="spot"
        title="Spot against on-demand"
        note="The same instance at its spot and on-demand prices, per provider."
      >
        <TerminalSpotPrices :spot="utilization.spot" />
      </TerminalPanel>

      <TerminalPanel
        v-if="gpu?.history.dates.length"
        id="gpu-history"
        title="Prices over time"
        note="The median on-demand price, and spot as a share of on-demand."
      >
        <TerminalGpuHistory :history="gpu.history" :sources="gpuSources" />
      </TerminalPanel>

      <TerminalPanel
        v-if="gpu?.archived"
        id="gpu-archived"
        title="Archived GPU prices"
        note="Weekly median on-demand price on the Internet Archive’s copies of each provider’s price page."
      >
        <TerminalGpuArchive :archived="gpu.archived" />
      </TerminalPanel>

      <TerminalPanel
        v-if="utilization.implied"
        id="implied-load"
        title="Implied load on Google’s fleet"
        note="Alphabet’s stated token volume at each benchmark model’s speed, as a share of Epoch AI’s estimate of Google’s fleet. A range per model."
      >
        <TerminalImpliedLoad :implied="utilization.implied" :shape="utilization.demand_shape" />
      </TerminalPanel>

      <TerminalPanel
        v-if="utilization.benchmark_rounds"
        id="benchmark-rounds"
        title="Benchmark speed, round over round"
        note="MLPerf Inference tokens per second per accelerator."
      >
        <TerminalBenchmarkRounds :rounds="utilization.benchmark_rounds" />
      </TerminalPanel>

      <TerminalPanel
        v-if="utilization.coreweave"
        id="revenue-per-mw"
        title="CoreWeave revenue per megawatt"
        note="Filed revenue against the active power CoreWeave states each quarter."
      >
        <TerminalRevenuePerMw :coreweave="utilization.coreweave" />
      </TerminalPanel>
    </template>

    <template v-if="power?.snapshot">
      <TerminalPanel
        id="power"
        title="Data-center power per lab"
        note="Epoch AI’s estimate, for sites where Epoch names the lab a confident or likely user."
      >
        <TerminalDataCenterPower :data="power" />
      </TerminalPanel>

      <TerminalPanel
        v-if="suppliers?.sites.length || suppliers?.uncovered.length"
        id="suppliers"
        title="Who powers the lab sites"
        note="The utility, generator, equipment maker or site host for each lab site. Planned is Epoch’s furthest estimate."
      >
        <TerminalPowerSites :data="suppliers" />
      </TerminalPanel>

      <TerminalPanel
        v-if="grid?.areas.length"
        id="grid-load"
        title="Grid load where the lab sites are"
        note="Average demand on each grid that holds a lab site, from EIA. Grid demand, not data-center use."
      >
        <TerminalGridLoad :data="grid" />
      </TerminalPanel>

      <TerminalPanel
        v-if="grid?.ercot.months.length"
        id="ercot-large-loads"
        title="Large loads on ERCOT"
        note="Large load ERCOT has approved to energize, and the sum of each one’s monthly peak, from ERCOT’s monthly reports."
      >
        <TerminalErcotLargeLoads :ercot="grid.ercot" :caveat="grid.caveat" />
      </TerminalPanel>

      <TerminalPanel
        id="sites"
        title="Every site"
        :note="`${count(power.sites)} sites in Epoch’s data as of ${stamps.day(power.snapshot)}, largest first.`"
      >
        <TerminalTable
          caption="AI data centers tracked by Epoch AI, with estimated power and named users"
          :columns="siteColumns"
          :rows="sites"
          :row-key="(s) => s.name"
          nested
          flow
        />
        <template #foot>
          <TerminalSources :sources="power.source ? [power.source] : []">
            <span>CC BY 4.0, Epoch AI</span>
          </TerminalSources>
        </template>
      </TerminalPanel>
    </template>
  </TerminalPage>
</template>
