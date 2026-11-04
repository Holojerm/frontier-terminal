<script setup lang="ts">
// The buildout signal: open roles in the physical-infrastructure department
// cluster (sources.yaml `department_clusters`) per lab, now against the
// comparison instant, with the board's own department labels that were
// summed listed under the number — the sum is checkable, never a black box.
// The line chart (full page) draws the cluster per day across the boards.

import { count, signed } from '../../../shared/utils/terminal-format'
import { dayLabel } from '../../../shared/utils/thesis-format'
import type { ClusterSeries, HiringHistoryData } from '../../../shared/utils/terminal-types'

const props = defineProps<{
  history: HiringHistoryData
  /** The cluster id to show; the first registered one by default. */
  clusterId?: string
}>()

const clusterOf = (p: HiringHistoryData['providers'][number]): ClusterSeries | null =>
  p.clusters.find((c) => c.id === (props.clusterId ?? p.clusters[0]?.id)) ?? null

const label = computed(
  () =>
    props.history.providers.map(clusterOf).find((c) => c !== null)?.label ??
    'Physical infrastructure',
)

const boards = computed(() =>
  props.history.providers.filter((p) => p.feed === 'ok' && p.dates.length > 0),
)

const chart = computed(() => {
  const dates = [...new Set(boards.value.flatMap((p) => p.dates))].sort()
  return {
    x: dates,
    series: boards.value
      .map((p) => ({ p, c: clusterOf(p) }))
      .filter((x): x is { p: (typeof boards.value)[number]; c: ClusterSeries } => x.c !== null)
      .map(({ p, c }) => {
        const at = new Map(p.dates.map((d, i) => [d, c.series[i]!]))
        return { id: p.provider, label: p.display, values: dates.map((d) => at.get(d) ?? null) }
      }),
  }
})

// A lab with no public board gets one line under the cards, not a card of its
// own: an empty tile the size of a full one reads as a missing reading.
const fed = computed(() => props.history.providers.filter((p) => !feedGap('hiring', p)))
const unfed = computed(() => props.history.providers.filter((p) => feedGap('hiring', p)))

const shareOfBoard = (p: HiringHistoryData['providers'][number], n: number) => {
  const total = p.total.at(-1) ?? 0
  return total === 0 ? '' : `${Math.round((n / total) * 100)}% of the board`
}
</script>

<template>
  <div class="@container space-y-3">
    <TerminalLineChart
      v-if="chart.series.length && chart.x.length > 1"
      :x="chart.x"
      :series="chart.series"
      :format="count"
      :x-label="dayLabel"
      :title="`Open ${label} roles per day at ${chart.series.map((s) => s.label).join(', ')} from ${chart.x[0]} to ${chart.x.at(-1)}`"
    />

    <div class="grid gap-3 @2xl:grid-cols-2 @6xl:grid-cols-4">
      <TerminalCard
        v-for="p in fed"
        :id="`buildout-${p.provider}`"
        :key="p.provider"
        :title="p.display"
        :sources="p.sources"
      >
        <template #meta>
          <TerminalCaveatMark v-if="p.caveat" label="blended board" :text="p.caveat" />
          <span v-if="p.feed === 'ok' && clusterOf(p)">
            <span class="font-mono text-highlighted">{{ count(clusterOf(p)!.now) }}</span>
            open
            <template v-if="clusterOf(p)!.then !== null">
              ·
              <span class="font-mono">{{ signed(clusterOf(p)!.now - clusterOf(p)!.then!) }}</span>
              since {{ clusterOf(p)!.then_at }}
            </template>
          </span>
        </template>

        <TerminalGap
          v-if="!clusterOf(p)"
          inline
          title="No parsed roles yet"
          reason="We count them once we’ve read the board’s current listing."
        />
        <TerminalGap
          v-else-if="clusterOf(p)!.departments.length === 0"
          inline
          title="No department on this board matches the list below."
          reason="The zero reflects department labels, not hiring."
        />
        <template v-else>
          <p class="text-xs text-muted">{{ shareOfBoard(p, clusterOf(p)!.now) }}</p>
          <TerminalTable
            :caption="`${p.display} ${label} roles by the board’s own department label`"
            :columns="[
              { key: 'department', label: 'Department', class: 'max-w-48 truncate text-default' },
              { key: 'now', label: 'Open', numeric: true },
              { key: 'delta', label: 'Δ', numeric: true, class: 'text-muted' },
            ]"
            :rows="
              clusterOf(p)!.departments.map((d) => ({
                ...d,
                delta:
                  clusterOf(p)!.then !== null && d.now !== d.then ? signed(d.now - d.then) : '',
              }))
            "
            :row-key="(d) => d.department"
            nested
          >
            <template #cell-department="{ row: d }">
              <span :title="d.department">{{ d.department }}</span>
            </template>
          </TerminalTable>
        </template>
      </TerminalCard>
    </div>

    <p v-if="unfed.length" class="flex flex-wrap gap-x-6 gap-y-1 text-xs">
      <span v-for="p in unfed" :id="`buildout-${p.provider}`" :key="p.provider">
        <span class="mr-1 text-default">{{ p.display }}</span>
        <TerminalGap inline v-bind="feedGap('hiring', p)!" />
      </span>
    </p>

    <p class="text-xs text-muted">
      We count a department when the board’s own label contains Data Center, Infrastructure,
      Facilities, Energy, Construction, Compute, or Hardware, unless it also says “Software”.
    </p>
  </div>
</template>
