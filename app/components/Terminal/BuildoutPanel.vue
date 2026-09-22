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
          <h3 :id="`buildout-${p.provider}`" class="text-lg text-highlighted">{{ p.display }}</h3>
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

        <UAlert
          v-if="p.feed === 'no_public_feed'"
          color="info"
          variant="soft"
          icon="i-lucide-eye-off"
          title="No public feed"
          :description="`${p.reason ?? ''} Verdict transcribed from the source audit — showing nothing beats guessing.`"
        />

        <TerminalEmptyState
          v-else-if="p.feed === 'no_rows' || !clusterOf(p)"
          title="No parsed roles yet."
          body="The cluster is read off the board’s current listing; it fills when the board’s parser lane runs."
        />

        <template v-else>
          <TerminalEmptyState
            v-if="clusterOf(p)!.departments.length === 0"
            title="No department on this board matches the cluster."
            body="The board’s own department labels name none of the cluster terms; a zero here is a label fact, not a hiring one."
          />
          <template v-else>
            <p class="text-xs text-toned">
              {{ shareOfBoard(p, clusterOf(p)!.now) }} · summed from the board’s own labels:
            </p>
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
          <UAlert
            v-if="p.caveat"
            color="warning"
            variant="soft"
            icon="i-lucide-triangle-alert"
            title="Entity-blended board"
            :description="p.caveat"
          />
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
      A department belongs to the cluster when its name, as the board prints it, contains one of the
      cluster’s terms (Data Center, Infrastructure, Facilities, Energy, Construction, Compute,
      Hardware) and not “Software”. Terms live in the source registry, and the judge reads the same
      list: a five-role move across these departments at one lab is a capacity signal, not a hiring
      one.
    </p>
    <p v-if="compact" class="text-sm">
      <NuxtLink to="/hiring#buildout" class="text-primary underline underline-offset-2">
        Cluster per day, per lab
      </NuxtLink>
    </p>
  </div>
</template>
