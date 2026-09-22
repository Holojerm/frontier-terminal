<script setup lang="ts">
// The buildout signal: open roles in the physical-infrastructure department
// cluster (sources.yaml `department_clusters`) per lab, now against the
// comparison instant, with the board's own department labels that were
// summed listed under the number — the sum is checkable, never a black box.
// The line chart (full page) draws the cluster per day across the boards.

import { absoluteStamp, count } from '#shared/utils/terminal-format'
import type { ClusterSeries, HiringHistoryData } from '#shared/utils/terminal-types'

const props = defineProps<{
  history: HiringHistoryData
  /** The cluster id to show; the first registered one by default. */
  clusterId?: string
  /** On the landing page: the cards and a link, no chart. */
  compact?: boolean
}>()

const now = useNow()

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

const xLabel = (d: string) => absoluteStamp(`${d}T00:00:00Z`, now.value).replace(/ \d\d:\d\dZ$/, '')
const signed = (n: number) => (n > 0 ? `+${n}` : String(n))
const shareOfBoard = (p: HiringHistoryData['providers'][number], n: number) => {
  const total = p.total.at(-1) ?? 0
  return total === 0 ? '' : `${Math.round((n / total) * 100)}% of the board`
}
</script>

<template>
  <div class="space-y-4">
    <TerminalLineChart
      v-if="!compact && chart.series.length && chart.x.length > 1"
      :x="chart.x"
      :series="chart.series"
      :format="count"
      :x-label="xLabel"
      :title="`Open ${label} roles per day at ${chart.series.map((s) => s.label).join(', ')} from ${chart.x[0]} to ${chart.x.at(-1)}`"
    />

    <div class="grid gap-4 md:grid-cols-2">
      <article
        v-for="p in history.providers"
        :key="p.provider"
        :aria-labelledby="`buildout-${p.provider}`"
        class="space-y-3 rounded border border-default bg-elevated p-4"
      >
        <header class="flex flex-wrap items-baseline justify-between gap-2">
          <h3 :id="`buildout-${p.provider}`" class="text-lg text-highlighted">
            {{ p.display }}
            <TerminalCaveatMark
              v-if="p.caveat"
              label="blended board"
              :text="p.caveat"
              class="ml-1"
            />
          </h3>
          <span v-if="p.feed === 'ok' && clusterOf(p)" class="text-sm text-toned">
            <span class="font-mono text-highlighted">{{ clusterOf(p)!.now }}</span>
            open
            <template v-if="clusterOf(p)!.then !== null">
              ·
              <span class="font-mono">{{ signed(clusterOf(p)!.now - clusterOf(p)!.then!) }}</span>
              since {{ clusterOf(p)!.then_at }}
            </template>
          </span>
        </header>

        <p v-if="p.feed === 'no_public_feed'" class="flex items-center gap-1 text-sm text-toned">
          No public feed
          <TerminalCaveatMark
            :name="`Why ${p.display} has no hiring feed`"
            :text="p.reason ?? ''"
          />
        </p>

        <TerminalEmptyState
          v-else-if="p.feed === 'no_rows' || !clusterOf(p)"
          title="No parsed roles yet."
          body="The cluster is read off the board’s current listing; it fills when the board’s parser lane runs."
        />

        <template v-else>
          <TerminalEmptyState
            v-if="clusterOf(p)!.departments.length === 0"
            title="No matching department on this board."
            body="A zero here is a label fact, not a hiring one."
          />
          <template v-else>
            <p class="text-xs text-toned">{{ shareOfBoard(p, clusterOf(p)!.now) }}</p>
            <ul class="space-y-1">
              <li
                v-for="d in clusterOf(p)!.departments"
                :key="d.department"
                class="flex items-baseline justify-between gap-2 text-xs"
              >
                <span class="truncate text-default" :title="d.department">{{ d.department }}</span>
                <span class="whitespace-nowrap font-mono text-default">
                  {{ d.now }}
                  <span v-if="clusterOf(p)!.then !== null && d.now !== d.then" class="text-toned">{{
                    signed(d.now - d.then)
                  }}</span>
                </span>
              </li>
            </ul>
          </template>
        </template>

        <ul v-if="p.sources.length" class="space-y-1">
          <li v-for="s in p.sources" :key="s.source_id">
            <TerminalProvenanceTag
              :label="s.label"
              :source-url="s.source_url"
              :fetched-at="s.fetched_at"
            />
          </li>
        </ul>
      </article>
    </div>

    <p class="text-xs text-muted">
      A department counts when the board’s own label contains Data Center, Infrastructure,
      Facilities, Energy, Construction, Compute or Hardware, and not “Software”.
    </p>
  </div>
</template>
