<script setup lang="ts">
// A measured claim: the newest reading with its provenance, the series behind
// it, and the same numbers as a table (the chart never gates a value).

import { dayLabel, detailRows, formatValue, valueKind } from '../../../shared/utils/thesis-format'
import type { ClaimView } from '../../../shared/utils/thesis-types'

const props = defineProps<{ claim: ClaimView }>()

const latest = computed(() => props.claim.latest)
const kind = computed(() => valueKind(latest.value?.detail, props.claim.format))
const format = (v: number) => formatValue(kind.value, v)
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
            :sub="`for ${latest.date}`"
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
          :x-label="dayLabel"
          :title="`${claim.signal_label}, ${series.length} readings from ${chart.x[0]} to ${chart.x.at(-1)}`"
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
              <time :datetime="p.date" :title="dayLabel(p.date)">{{ p.date }}</time>
            </template>
            <template #cell-value="{ row: p }">{{ format(p.value) }}</template>
            <template #cell-note="{ row: p }">{{ p.note ?? '' }}</template>
          </TerminalTable>
        </TerminalExpand>
      </div>
    </div>
  </div>
</template>
