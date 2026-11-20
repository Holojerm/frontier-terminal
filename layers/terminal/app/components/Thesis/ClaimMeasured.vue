<script setup lang="ts">
// A measured claim: the newest reading with its provenance, the series behind
// it, and the same numbers as a table (the chart never gates a value).

import {
  dayLabel,
  detailRows,
  formatTick,
  formatValue,
  valueKind,
} from '../../../shared/utils/thesis-format'
import type { ClaimView } from '../../../shared/utils/thesis-types'

const props = defineProps<{ claim: ClaimView }>()
const stamps = useStamps()

const latest = computed(() => props.claim.latest)
const kind = computed(() => valueKind(latest.value?.detail, props.claim.format))
const format = (v: number) => formatValue(kind.value, v)
const tick = (v: number) => formatTick(kind.value, v)
const context = computed(() => detailRows(latest.value?.detail))

const series = computed(() => props.claim.series)
const chart = computed(() => ({
  x: series.value.map((p) => p.date),
  series: [
    {
      id: props.claim.id,
      // Empty: one series needs no legend, and an end label would clip.
      label: '',
      values: series.value.map((p) => p.value),
    },
  ],
}))
// The level the claim dies at, drawn on its chart: without it the line has no meaning.
const killRule = computed(() =>
  typeof props.claim.kill_line === 'number'
    ? { value: props.claim.kill_line, label: `Kill line ${format(props.claim.kill_line)}` }
    : undefined,
)
const newestFirst = computed(() => [...series.value].reverse())
const hasNotes = computed(() => series.value.some((p) => p.note))
const columns = computed(() => [
  { key: 'date', label: 'Date', class: 'font-mono' },
  { key: 'value', label: 'Value', numeric: true },
  ...(hasNotes.value ? [{ key: 'note', label: 'Note' }] : []),
])
</script>

<template>
  <div class="space-y-3">
    <TerminalGap
      v-if="!latest"
      title="No reading yet."
      reason="We don’t have a number for this claim yet. Its status stays unresolved until we do."
    />

    <!-- From lg the reading sits beside its series: stacked, a claim was a
         tall narrow column with the chart a screen below its number. -->
    <div v-else class="grid gap-x-6 gap-y-3 lg:grid-cols-3">
      <div class="space-y-3">
        <dl>
          <TerminalFigure
            label="Latest reading"
            :value="format(latest.value)"
            :sub="`for ${stamps.day(latest.date)}`"
            :source="latest"
          />
        </dl>
        <TerminalFacts
          v-if="context.length"
          layout="list"
          :items="
            context.map((row) => ({
              key: row.label,
              label: row.label,
              value: row.value,
              mono: true,
            }))
          "
        />
      </div>

      <div class="space-y-3 lg:col-span-2">
        <TerminalLineChart
          v-if="series.length > 1"
          :x="chart.x"
          :series="chart.series"
          :format="format"
          :tick-format="tick"
          :x-label="dayLabel"
          :rule="killRule"
          :title="`${claim.signal_label}, ${series.length} readings from ${stamps.day(chart.x[0]!)} to ${stamps.day(chart.x.at(-1)!)}${killRule ? `, against a kill line of ${format(killRule.value)}` : ''}`"
        />
        <p v-else class="text-sm text-muted">One reading so far. A trend needs at least two.</p>

        <TerminalExpand v-if="series.length > 1" show="Show the readings" hide="Hide the readings">
          <TerminalTable
            :caption="`${claim.signal_label}, newest first`"
            :columns="columns"
            :rows="newestFirst"
            :row-key="(p) => p.date"
            nested
          >
            <template #cell-date="{ row: p }">
              <time :datetime="p.date" :title="p.date">{{ stamps.day(p.date) }}</time>
            </template>
            <template #cell-value="{ row: p }">{{ format(p.value) }}</template>
            <template #cell-note="{ row: p }">{{ p.note ?? '' }}</template>
          </TerminalTable>
        </TerminalExpand>
      </div>
    </div>
  </div>
</template>
