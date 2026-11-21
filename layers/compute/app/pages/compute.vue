<script setup lang="ts">
// The compute layer: what renting a GPU costs and how full the capacity looks
// from outside. All read the thesis recipes (GPU price pages, SEC filings,
// MLPerf results and Epoch AI's datasets). Every figure has its source and
// fetch time. The hardware prints and the power panels moved to /hardware and
// /power; MOVED forwards their old anchors there.

import type { UtilizationData } from '../../shared/utils/compute-views'
import type { GpuPricesData } from '../../shared/utils/terminal-types/gpu-prices'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Compute',
    summary:
      'On-demand H100 and B200 rental list prices from ten first-party provider pages with the median across them, spot prices against on-demand per provider, both charted on each day a provider’s page changed, the weekly median back to 2023 from the Internet Archive’s copies of those pages, Alphabet’s stated token volume as a bounded share of Google’s estimated fleet, MLPerf Inference tokens per second per accelerator in each round we hold, and CoreWeave’s revenue per megawatt of active power, each with its source page.',
  },
})

// A fragment never reaches the server, so the forward runs in the browser.
const MOVED: Record<string, string> = {
  prints: '/hardware',
  power: '/power',
  suppliers: '/power',
  'grid-load': '/power',
  'ercot-large-loads': '/power',
  sites: '/power',
}
const route = useRoute()
onMounted(() => {
  const to = MOVED[route.hash.slice(1)]
  if (to) navigateTo({ path: to, hash: route.hash }, { replace: true })
})

const [{ data: gpu, error }, { data: utilization }] = await Promise.all([
  useFetch<GpuPricesData>('/api/gpu-prices'),
  useFetch<UtilizationData>('/api/utilization'),
])

useSeo({
  title: 'GPU rental prices, spot share, and utilization bounds',
  description:
    'H100 and B200 rental prices and spot prices from provider pages, bounds on the load Google’s token volume implies, MLPerf speeds and CoreWeave revenue per MW.',
  dateModified: gpu.value?.as_of,
})

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
</script>

<template>
  <TerminalPage
    title="Compute"
    lede="What a GPU-hour rents for, and how full the capacity looks from public data."
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
  </TerminalPage>
</template>
