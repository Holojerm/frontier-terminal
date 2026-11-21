<script setup lang="ts">
// The power layer: Epoch AI's estimate of data-center power per lab and per
// site, who powers each lab site (read from filings and pages,
// layers/terminal/shared/utils/power-sites.ts), and the grid load where the sites are
// (EIA-930 and ERCOT, layers/terminal/shared/utils/grid-load.ts). Every figure has its
// source and fetch time. The site list is the page's long table and runs with
// the page rather than in a box.

import { count } from '../../shared/utils/terminal-format'
import type { GridLoadData } from '../../shared/utils/grid-load'
import type { PowerSitesData } from '../../shared/utils/power-sites'
import type { DataCentersData } from '../../shared/utils/recipe-views'
import type { TableColumn } from '../types/terminal-ui'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.7',
    title: 'Power',
    summary:
      'Epoch AI’s estimate of data-center power per frontier lab and per site, the utilities, generators and equipment makers tied to each lab’s sites, average demand on each grid that holds a lab site against a year before (EIA-930), and the large load ERCOT has approved to energize, each with its source page.',
  },
})

const [{ data: power, error }, { data: suppliers }, { data: grid }] = await Promise.all([
  useFetch<DataCentersData>('/api/datacenters'),
  useFetch<PowerSitesData>('/api/power-sites'),
  useFetch<GridLoadData>('/api/grid-load'),
])

useSeo({
  title: 'AI data-center power per lab and site, the utilities behind them, and grid load',
  description:
    'Data-center power per frontier lab and per site from Epoch AI, the utilities and generators tied to each site, and grid load where the sites are.',
  dateModified: power.value?.as_of,
})

const stamps = useStamps()

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
    title="Power"
    lede="How much data-center power each lab is bringing online, who supplies it, and the load on the grids where the sites are."
    :as-of="power?.as_of"
    :error="Boolean(error)"
    error-title="Data-center power didn’t load"
    error-body="Try reloading in a minute."
  >
    <TerminalPanel
      v-if="power?.snapshot"
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
      v-if="power?.snapshot"
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
  </TerminalPage>
</template>
