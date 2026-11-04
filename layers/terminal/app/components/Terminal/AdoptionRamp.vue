<script setup lang="ts">
// Ramp's monthly enterprise adoption: the share of US businesses on Ramp
// paying each vendor. The chart draws any-AI, Anthropic and OpenAI (three
// series at most, DESIGN.md › charts); the table carries every vendor Ramp
// reports, so the chart never gates a number. `labs` narrows both to one lab
// beside the any-AI line, for the lab pages.

import type { AdoptionData } from '../../../shared/utils/recipe-views'
import type { LabId } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{
  ramp: NonNullable<AdoptionData['ramp']>
  caveat: string
  labs?: LabId[]
}>()

const pct = (v: number) => `${v.toFixed(1)}%`
const monthLabel = (m: string) =>
  new Date(`${m}T00:00:00Z`).toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })

const shown = computed(() =>
  props.ramp.series.filter(
    (s) => s.key === 'overall' || !props.labs || (s.lab !== null && props.labs.includes(s.lab)),
  ),
)
const chartSeries = computed(() =>
  (props.labs
    ? shown.value
    : shown.value.filter((s) => ['overall', 'anthropic', 'openai'].includes(s.key))
  ).map((s) => ({ id: s.key, label: s.label, values: s.values })),
)

const n = computed(() => props.ramp.months.length)
const columns: TableColumn[] = [
  { key: 'label', label: 'Vendor' },
  { key: 'now', label: 'Newest month', numeric: true },
  { key: 'year', label: 'A year earlier', numeric: true },
  { key: 'change', label: 'Change', numeric: true, hint: 'points' },
]
const rows = computed(() =>
  shown.value.map((s) => {
    const now = s.values[n.value - 1] ?? null
    const year = n.value > 12 ? (s.values[n.value - 13] ?? null) : null
    return {
      key: s.key,
      label: s.label,
      now: now === null ? '—' : pct(now),
      year: year === null ? '—' : pct(year),
      change:
        now === null || year === null
          ? '—'
          : `${now - year >= 0 ? '+' : '−'}${Math.abs(now - year).toFixed(1)}`,
    }
  }),
)
</script>

<template>
  <div class="space-y-3">
    <TerminalLineChart
      v-if="ramp.months.length > 1"
      :x="ramp.months"
      :series="chartSeries"
      :format="pct"
      :x-label="monthLabel"
      :title="`Share of US businesses on Ramp paying ${chartSeries.map((s) => s.label).join(', ')}, monthly, ${monthLabel(ramp.months[0]!)} to ${monthLabel(ramp.months.at(-1)!)}`"
    />
    <TerminalTable
      :caption="`Share of US businesses on Ramp paying each vendor, ${monthLabel(ramp.months.at(-1)!)}`"
      :columns="columns"
      :rows="rows"
      :row-key="(r) => r.key"
      nested
    />
    <TerminalSources
      :sources="[ramp.source]"
      :caveats="[{ text: caveat, label: 'adoption, not spend' }]"
    >
      <span>Release first seen {{ ramp.release_seen }}</span>
    </TerminalSources>
  </div>
</template>
