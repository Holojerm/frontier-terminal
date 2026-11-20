<script setup lang="ts">
// GPU rental prices over time: per GPU, the median on-demand price and the
// spot price as a share of on-demand, on each day a provider's page changed.
// Two measures of different scale, so two charts per GPU over the same dates.
// The spot chart draws the combined share once the payload prints one; below
// the quorum it draws each provider, which is three lines at most. A range is
// drawn at its lower end and printed in full in the table under the charts.

import { gpuHour } from '../../../shared/utils/terminal-format'
import { dayLabel } from '../../../shared/utils/thesis-format'
import type { GpuHistoryView, SpotShare } from '../../../shared/utils/terminal-types'
import type { Citation, TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ history: GpuHistoryView; sources?: Citation[] }>()

const pct = (n: number) => `${(n * 100).toFixed(1)}%`
const wholePct = (n: number) => `${Math.round(n * 100)}%`
const range = (s: SpotShare) =>
  pct(s.low) === pct(s.high) ? pct(s.low) : `${pct(s.low)}–${pct(s.high)}`

/** 'Google Cloud joined', 'Verda left': the providers behind the median changed that day. */
const setNote = (c: { joined: string[]; left: string[] }) =>
  [
    ...(c.joined.length ? [`${c.joined.join(', ')} joined`] : []),
    ...(c.left.length ? [`${c.left.join(', ')} left`] : []),
  ].join(', ')

/** A line needs two points; one read is a number in the table, not a chart. */
const drawable = (values: (number | null)[]) => values.filter((v) => v !== null).length > 1

const first = computed(() => props.history.dates[0] ?? '')
const last = computed(() => props.history.dates.at(-1) ?? '')

const charts = computed(() =>
  props.history.gpus.map((g) => {
    const combined = g.spot_combined.some((s) => s !== null)
    const spot = combined
      ? [
          {
            id: 'combined',
            label: 'Median',
            values: g.spot_combined.map((s) => s?.low ?? null),
          },
        ]
      : g.spot.map((p) => ({
          id: p.provider,
          label: p.provider_name,
          values: p.share.map((s) => s?.low ?? null),
        }))
    return {
      gpu: g.gpu,
      notes: g.provider_changes.map((c) => `${dayLabel(c.date)}: ${setNote(c)}`),
      price: [{ id: 'median', label: 'Median', values: g.median }],
      spot: spot.filter((s) => drawable(s.values)),
      spotRead: g.spot.length > 0,
      spotOf: combined ? 'the median across providers' : spot.map((s) => s.label).join(', '),
    }
  }),
)

const columns: TableColumn[] = [
  { key: 'date', label: 'Date', class: 'whitespace-nowrap font-mono text-xs' },
  { key: 'gpu', label: 'GPU' },
  { key: 'median', label: 'Median $ per GPU-hour', numeric: true },
  { key: 'providers', label: 'Providers', numeric: true },
  { key: 'spot', label: 'Spot as % of on-demand' },
]

const rows = computed(() =>
  props.history.dates
    .map((date, i) =>
      props.history.gpus.map((g) => {
        const combined = g.spot_combined[i]
        const singles = g.spot
          .filter((p) => p.share[i])
          .map((p) => `${p.provider_name} ${range(p.share[i]!)}`)
        const change = g.provider_changes.find((c) => c.date === date)
        return {
          key: `${date}:${g.gpu}`,
          date,
          gpu: g.gpu,
          median: gpuHour(g.median[i] ?? null),
          providers: change
            ? `${g.providers[i] ?? 0} (${setNote(change)})`
            : `${g.providers[i] ?? 0}`,
          spot: combined
            ? `${range(combined)} across ${singles.length} providers`
            : singles.join(', ') || 'none printed',
        }
      }),
    )
    .reverse()
    .flat(),
)
</script>

<template>
  <div class="space-y-3">
    <TerminalGap
      v-if="history.dates.length < 2"
      title="One day of prices so far."
      reason="A line needs two. The table has the first read."
    />
    <div v-else class="grid gap-3 lg:grid-cols-2">
      <TerminalCard v-for="c in charts" :id="`gpu-history-${c.gpu}`" :key="c.gpu" :title="c.gpu">
        <div class="space-y-1">
          <h4 class="text-xs text-muted">Median on-demand price, $ per GPU-hour</h4>
          <TerminalLineChart
            :x="history.dates"
            :series="c.price"
            :format="gpuHour"
            :x-label="dayLabel"
            step
            :title="`Median on-demand ${c.gpu} list price per GPU-hour across providers, ${dayLabel(first)} to ${dayLabel(last)}`"
          />
          <p v-if="c.notes.length" class="text-xs text-muted">
            Providers counted changed, which moves the median with no price moving.
            {{ c.notes.join('. ') }}.
          </p>
        </div>
        <div class="space-y-1">
          <h4 class="text-xs text-muted">Spot price as % of on-demand</h4>
          <TerminalLineChart
            v-if="c.spot.length"
            :x="history.dates"
            :series="c.spot"
            :format="pct"
            :tick-format="wholePct"
            :y-max="1"
            :x-label="dayLabel"
            step
            :title="`${c.gpu} spot price as a share of the on-demand price for ${c.spotOf}, ${dayLabel(first)} to ${dayLabel(last)}`"
          />
          <TerminalGap
            v-else-if="c.spotRead"
            inline
            title="One day of spot prices so far"
            reason="A line needs two. The table has the first read."
          />
          <TerminalGap
            v-else
            inline
            title="No spot price yet"
            :reason="`None of the provider pages we read has printed a spot price for the ${c.gpu}.`"
          />
        </div>
      </TerminalCard>
    </div>

    <TerminalExpand show="Every date, as a table" hide="Hide the table">
      <TerminalTable
        caption="Median on-demand GPU price and spot price as a share of on-demand, per date and GPU, newest first"
        :columns="columns"
        :rows="rows"
        :row-key="(r) => r.key"
        nested
      />
    </TerminalExpand>

    <TerminalSources :sources="sources" :caveats="[{ text: history.method, label: 'method' }]" />
  </div>
</template>
