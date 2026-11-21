<script setup lang="ts">
// ERCOT's own count of large loads: approved to energize and the sum of each
// approved load's monthly peak, per month from the newest report that states it,
// and the queue size where stated. Each row cites its report and sentence.

import { type ErcotLargeLoads } from '../../../shared/utils/grid-load'

const props = defineProps<{ ercot: ErcotLargeLoads; caveat: string }>()

const mw = (v: number) => `${count(Math.round(v))} MW`
const gw = (v: number) => `${trimmed(v / 1000, 1)} GW`

const x = computed(() => props.ercot.months.map((m) => `${m.period}-01`))
const series = computed(() => [
  { id: 'approved', label: 'Approved', values: props.ercot.months.map((m) => m.approved_mw) },
  { id: 'observed', label: 'Observed', values: props.ercot.months.map((m) => m.observed_peak_mw) },
])

const columns: TableColumn[] = [
  { key: 'month', label: 'Month' },
  { key: 'approved', label: 'Approved to energize', numeric: true },
  { key: 'observed', label: 'Sum of monthly peaks', numeric: true },
  { key: 'source', label: 'Report' },
]
const rows = computed(() =>
  props.ercot.months.toReversed().map((m) => ({
    key: m.period,
    month: monthLabel(m.period),
    approved: m.approved_mw === null ? '—' : mw(m.approved_mw),
    observed: m.observed_peak_mw === null ? '—' : mw(m.observed_peak_mw),
    quote: m.quote,
    source_url: m.source_url,
    fetched_at: m.fetched_at,
  })),
)

const stated = computed(() =>
  [
    ...props.ercot.queue.map((f) => ({
      key: `q|${f.source_url}`,
      what: `Queue: ${f.qualifier ? `${f.qualifier} ` : ''}${gw(f.value_mw)}${f.horizon ? ` by ${f.horizon}` : ''}`,
      ...f,
    })),
    ...props.ercot.energized.map((f) => ({
      key: `e|${f.source_url}`,
      what: `Observed energized: ${gw(f.value_mw)}`,
      ...f,
    })),
  ].sort((a, b) => b.posted.localeCompare(a.posted)),
)
</script>

<template>
  <div class="space-y-4">
    <TerminalGap
      v-if="!ercot.months.length"
      title="No ERCOT report read yet."
      reason="The first read of ERCOT’s monthly reports has not run."
    />
    <template v-else>
      <TerminalLineChart
        v-if="ercot.months.length > 1"
        :x="x"
        :series="series"
        :format="mw"
        :x-label="monthLabel"
        title="Large load ERCOT has approved to energize, and the sum of each approved load’s own monthly peak, by month"
      />
      <TerminalTable
        caption="Large load ERCOT has approved to energize and the sum of each approved load’s own monthly peak, from the newest report that states the month"
        :columns="columns"
        :rows="rows"
        :row-key="(r) => r.key"
        nested
      >
        <template #cell-source="{ row }">
          <TerminalProvenanceTag :source-url="row.source_url" :fetched-at="row.fetched_at" />
        </template>
      </TerminalTable>
    </template>
    <ul v-if="stated.length" class="space-y-2 text-sm">
      <li v-for="s in stated" :key="s.key">
        <p class="font-mono text-highlighted">{{ s.what }}</p>
        <p class="text-muted">“{{ s.quote }}”</p>
        <TerminalProvenanceTag :source-url="s.source_url" :fetched-at="s.fetched_at" />
      </li>
    </ul>
    <TerminalSources :caveats="[{ text: caveat, label: 'how to read this' }]">
      <span>Source: ERCOT</span>
    </TerminalSources>
  </div>
</template>
