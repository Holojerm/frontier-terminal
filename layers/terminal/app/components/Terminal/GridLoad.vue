<script setup lang="ts">
// Demand on each grid a lab site sits in (EIA-930): the newest whole month
// against the same month a year before, a small chart per grid of that change
// month by month on one shared scale, and the sites with the page that places
// each one. The numbers in the charts are in the table too.

import { count, signedPercent } from '../../../shared/utils/terminal-format'
import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import { monthLabel, type GridLoadData } from '../../../shared/utils/grid-load'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ data: GridLoadData }>()

const mw = (v: number) => `${count(Math.round(v))} MW`
const change = (v: number | null) => (v === null ? '—' : signedPercent(v * 100))
const labs = (ids: readonly string[]) =>
  ids.map((l) => (LAB_DISPLAY as Record<string, string>)[l] ?? l).join(', ')

const columns: TableColumn[] = [
  { key: 'area', label: 'Grid' },
  { key: 'sites', label: 'Lab sites' },
  { key: 'tickers', label: 'Listed companies' },
  { key: 'month', label: 'Month' },
  { key: 'load', label: 'Average load', numeric: true },
  { key: 'yoy', label: 'vs a year before', numeric: true },
  { key: 'source', label: 'Source' },
]

const rows = computed(() =>
  props.data.areas.map((a) => ({
    key: a.ba,
    area: a.short,
    sites: a.sites.map((s) => s.site).join(', '),
    tickers: a.tickers.map((t) => t.ticker).join(', ') || '—',
    month: a.latest ? monthLabel(a.latest.month) : '—',
    load: a.latest ? mw(a.latest.avg_mw) : '—',
    yoy: change(a.latest?.yoy ?? null),
    source: a.source,
  })),
)

// The change on a year before, month by month, on one scale across grids.
const charted = computed(() =>
  props.data.areas.filter((a) => a.monthly.some((m) => m.yoy !== null)),
)
const span = computed(() => {
  let top = 0
  for (const a of charted.value)
    for (const m of a.monthly) top = Math.max(top, Math.abs(m.yoy ?? 0))
  return top
})
const charts = computed(() =>
  charted.value.map((a) => {
    const months = a.monthly.filter((m) => m.yoy !== null)
    return {
      ba: a.ba,
      title: a.short,
      x: months.map((m) => `${m.month}-01`),
      series: [{ id: a.ba, label: a.short, values: months.map((m) => m.yoy) }],
    }
  }),
)

const siteColumns: TableColumn[] = [
  { key: 'site', label: 'Site' },
  { key: 'labs', label: 'Labs' },
  { key: 'area', label: 'Grid' },
  { key: 'basis', label: 'Placed by', class: 'min-w-64' },
  { key: 'source', label: 'Source' },
]
const sites = computed(() =>
  props.data.areas
    .flatMap((a) =>
      a.sites.map((s) => ({
        key: `${a.ba}|${s.site}`,
        site: s.site,
        labs: labs(s.labs),
        area: a.short,
        basis: s.basis === 'grid' ? 'The page names its grid' : `${s.via}, in EIA-861`,
        quote: s.quote,
        source_url: s.source_url,
        fetched_at: s.fetched_at,
        mw_now: s.mw_now,
      })),
    )
    .sort((a, b) => b.mw_now - a.mw_now),
)
const standing = computed(() => props.data.gaps.filter((g) => g.site === null))
const unplaced = computed(() => props.data.unplaced.map((u) => u.site).join(', '))
</script>

<template>
  <div class="space-y-4">
    <TerminalGap
      v-if="!data.areas.length"
      title="No grid placed yet."
      reason="No page we have read places a lab site on a grid."
    />
    <template v-else>
      <TerminalTable
        caption="Average demand on each grid that holds a lab site, the newest whole month against the same month a year before"
        :columns="columns"
        :rows="rows"
        :row-key="(r) => r.key"
        nested
      >
        <template #cell-source="{ row }">
          <TerminalProvenanceTag
            v-if="row.source"
            :source-url="row.source.source_url"
            :fetched-at="row.source.fetched_at"
          />
        </template>
      </TerminalTable>
      <div v-if="charts.length" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TerminalCard v-for="c in charts" :id="`grid-load-${c.ba}`" :key="c.ba" :title="c.title">
          <TerminalLineChart
            :x="c.x"
            :series="c.series"
            :format="change"
            :x-label="monthLabel"
            :y-max="span"
            :height="140"
            :title="`${c.title} average monthly load against the same month a year before`"
          />
        </TerminalCard>
      </div>
      <TerminalTable
        caption="Each lab site placed on a grid, with the page or EIA-861 row that places it"
        :columns="siteColumns"
        :rows="sites"
        :row-key="(r) => r.key"
        align="top"
        nested
      >
        <template #cell-basis="{ row }">
          <p class="text-default">{{ row.basis }}</p>
          <p class="mt-1 text-muted">“{{ row.quote }}”</p>
        </template>
        <template #cell-source="{ row }">
          <TerminalProvenanceTag :source-url="row.source_url" :fetched-at="row.fetched_at" />
        </template>
      </TerminalTable>
    </template>
    <TerminalGap
      v-if="data.unplaced.length"
      inline
      title="Sites not placed yet"
      :reason="`No page we have read places ${unplaced} on a grid.`"
    />
    <TerminalGap v-for="g in standing" :key="g.id" inline :title="g.title" :reason="g.reason" />
    <TerminalSources :caveats="[{ text: data.caveat, label: 'how to read this' }]">
      <span>Source: U.S. Energy Information Administration, EIA-930 and EIA-861</span>
    </TerminalSources>
  </div>
</template>
