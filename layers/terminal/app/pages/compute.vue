<script setup lang="ts">
// The compute axis: what renting a GPU costs, and how much data-center power
// is coming online and for whom. Both read the thesis recipes (GPU price
// pages and Epoch AI's dataset), every figure with its source and fetch time.
// Three panels, so no tabs; the site list is the page's long table and runs
// with the page rather than in a box.

import { count } from '../../shared/utils/terminal-format'
import type { DataCentersData } from '../../shared/utils/recipe-views'
import type { GpuPricesData } from '../../shared/utils/terminal-types'
import type { TableColumn } from '../types/terminal-ui'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Compute',
    summary:
      'On-demand H100 and B200 rental list prices from nine first-party provider pages with the median across them, and Epoch AI’s estimate of data-center power per frontier lab and per site.',
  },
})

const [{ data: gpu, error }, { data: power }] = await Promise.all([
  useFetch<GpuPricesData>('/api/gpu-prices'),
  useFetch<DataCentersData>('/api/datacenters'),
])

useSeo({
  title: 'GPU rental prices and AI data-center power',
  description:
    'H100 and B200 rental prices from first-party provider pages, and Epoch AI’s estimate of data-center power per frontier lab and per site.',
  dateModified: gpu.value?.as_of,
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
    lede="What a GPU-hour rents for, and how much data-center power each lab is bringing online."
    :as-of="gpu?.as_of"
    :error="Boolean(error)"
    error-title="GPU prices could not be read"
    error-body="The GPU prices endpoint failed to respond."
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

    <template v-if="power?.snapshot">
      <TerminalPanel
        id="power"
        title="Data-center power per lab"
        note="Epoch AI’s estimate, attributed by the users it names at #confident or #likely."
      >
        <TerminalDataCenterPower :data="power" />
      </TerminalPanel>

      <TerminalPanel
        id="sites"
        title="Every site"
        :note="`${count(power.sites)} sites in Epoch’s data of ${power.snapshot}, largest first; owner and users as Epoch writes them.`"
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
