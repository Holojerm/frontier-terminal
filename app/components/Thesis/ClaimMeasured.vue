<script setup lang="ts">
// A measured claim: the newest reading with its provenance, the series behind
// it, and the same numbers as a table (the chart never gates a value).

import { absoluteStamp } from '#shared/utils/terminal-format'
import { dayLabel, detailRows, formatValue, valueKind } from '#shared/utils/thesis-format'
import type { ClaimView } from '#shared/utils/thesis-types'

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

const showTable = ref(false)
</script>

<template>
  <div class="space-y-4">
    <TerminalEmptyState
      v-if="!latest"
      title="No reading yet."
      body="The signal has not produced a number for this claim, so its status stays unresolved until it does."
    />

    <template v-else>
      <div class="space-y-1">
        <h3 class="text-sm text-toned">Latest reading</h3>
        <p class="flex flex-wrap items-baseline gap-x-3">
          <span class="font-display text-3xl text-highlighted">{{ format(latest.value) }}</span>
          <span class="text-sm text-muted">
            for <time :datetime="latest.date">{{ latest.date }}</time>
          </span>
        </p>
        <dl v-if="context.length" class="space-y-0.5 text-sm">
          <div v-for="row in context" :key="row.label" class="flex flex-wrap gap-x-2">
            <dt class="text-muted">{{ row.label }}</dt>
            <dd class="font-mono text-default">{{ row.value }}</dd>
          </div>
        </dl>
        <p class="text-xs text-toned">
          Source:
          <TerminalProvenanceTag :source-url="latest.source_url" :fetched-at="latest.fetched_at" />
        </p>
      </div>

      <TerminalLineChart
        v-if="series.length > 1"
        :x="chart.x"
        :series="chart.series"
        :format="format"
        :x-label="dayLabel"
        :title="`${claim.signal_label}, ${series.length} readings from ${chart.x[0]} to ${chart.x.at(-1)}`"
      />
      <p v-else class="text-sm text-muted">One reading so far. A trend needs at least two.</p>

      <UCollapsible v-if="series.length > 1" v-model:open="showTable" class="space-y-2">
        <UButton
          variant="link"
          color="neutral"
          size="sm"
          trailing-icon="i-lucide-chevron-down"
          class="px-0 text-toned"
          :label="showTable ? 'Hide the readings' : 'Show the readings'"
        />
        <template #content>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <caption class="sr-only">
                {{
                  claim.signal_label
                }}, newest first
              </caption>
              <thead>
                <tr class="border-b border-default text-left">
                  <th scope="col" class="py-2 pr-4 font-medium text-muted">Date</th>
                  <th scope="col" class="py-2 text-right font-medium text-muted">Value</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in newestFirst" :key="p.date" class="border-b border-default">
                  <th scope="row" class="py-1 pr-4 text-left font-normal">
                    <time :datetime="p.date" :title="absoluteStamp(`${p.date}T00:00:00Z`)">{{
                      p.date
                    }}</time>
                  </th>
                  <td class="py-1 text-right font-mono">{{ format(p.value) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </UCollapsible>
    </template>
  </div>
</template>
