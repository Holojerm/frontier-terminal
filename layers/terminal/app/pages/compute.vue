<script setup lang="ts">
// The compute axis: what renting a GPU costs, how full the capacity looks
// from outside, how much data-center power is coming online and for whom,
// and who supplies it. All read the thesis recipes (GPU price pages, SEC
// filings, MLPerf results and Epoch AI's datasets) except the power suppliers,
// which are read from filings and pages (layers/terminal/shared/utils/power-sites.ts). Every
// figure has its source and fetch time. No tabs; the site list is the page's
// long table and runs with the page rather than in a box.

import { count } from '../../shared/utils/terminal-format'
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
      'On-demand H100 and B200 rental list prices from nine first-party provider pages with the median across them, spot prices against on-demand per provider, both charted on each day a provider’s page changed, Alphabet’s stated token volume as a bounded share of Google’s estimated fleet, CoreWeave’s revenue per megawatt of active power, Epoch AI’s estimate of data-center power per frontier lab and per site, and the utilities, generators and equipment makers tied to each lab’s sites, each with its source page.',
  },
})

const [{ data: gpu, error }, { data: power }, { data: utilization }, { data: suppliers }] =
  await Promise.all([
    useFetch<GpuPricesData>('/api/gpu-prices'),
    useFetch<DataCentersData>('/api/datacenters'),
    useFetch<UtilizationData>('/api/utilization'),
    useFetch<PowerSitesData>('/api/power-sites'),
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
      note="On-demand list price per GPU-hour, first-party pages only. The Compute thesis divides flagship token prices by the H100 median."
      :more="{ label: 'The Compute thesis', to: '/theses/compute' }"
    >
      <TerminalGpuMedians :gpu="gpu" />
    </TerminalPanel>

    <template v-if="utilization">
      <TerminalPanel
        id="spot"
        title="Spot against on-demand"
        note="The same instance at its spot price and its on-demand price, per provider. Spot moves toward on-demand when spare capacity runs short."
      >
        <TerminalSpotPrices :spot="utilization.spot" />
      </TerminalPanel>

      <TerminalPanel
        v-if="gpu?.history.dates.length"
        id="gpu-history"
        title="Prices over time"
        note="The median on-demand price, and the spot price as a share of on-demand, on each day a provider’s page changed."
      >
        <TerminalGpuHistory :history="gpu.history" :sources="gpuSources" />
      </TerminalPanel>

      <TerminalPanel
        v-if="utilization.implied"
        id="implied-load"
        title="Implied load on Google’s fleet"
        note="Alphabet’s stated token volume at each benchmark model’s speed, as a share of Epoch AI’s estimate of Google’s fleet. A range per model, never one number."
      >
        <TerminalImpliedLoad :implied="utilization.implied" :shape="utilization.demand_shape" />
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
        note="Epoch AI’s estimate, credited to each lab Epoch names as a user at #confident or #likely."
      >
        <TerminalDataCenterPower :data="power" />
      </TerminalPanel>

      <TerminalPanel
        v-if="suppliers?.sites.length || suppliers?.uncovered.length"
        id="suppliers"
        title="Who powers the lab sites"
        note="The utility, generator, equipment maker or site host we read for each site Epoch credits to a lab, with the page it comes from. Planned is Epoch’s furthest estimate."
      >
        <TerminalPowerSites :data="suppliers" />
      </TerminalPanel>

      <TerminalPanel
        id="sites"
        title="Every site"
        :note="`${count(power.sites)} sites in Epoch’s data as of ${stamps.day(power.snapshot)}, largest first. Owner and users are as Epoch writes them.`"
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
