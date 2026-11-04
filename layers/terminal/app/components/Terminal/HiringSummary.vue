<script setup lang="ts">
// Hiring as one row per lab — open roles, the change over the comparison
// window, the physical-infrastructure cluster and its change, and the
// department that moved most. Department mix and the daily series are on
// /hiring. A board with no public feed is a row that says so; the xAI entity
// blend ships as a visible mark on its row, as the source audit requires.

import { count, signed } from '../../../shared/utils/terminal-format'
import type {
  ClusterSeries,
  HiringHistoryData,
  HiringHistoryProvider,
} from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ history: HiringHistoryData }>()

const cluster = (p: HiringHistoryProvider): ClusterSeries | null => p.clusters[0] ?? null

/** The department whose count moved most since the comparison instant, if any moved. */
const topMover = (p: HiringHistoryProvider) => {
  let best: { department: string; d: number } | null = null
  for (const r of p.compare?.departments ?? []) {
    const d = r.now - r.then
    if (d !== 0 && (best === null || Math.abs(d) > Math.abs(best.d)))
      best = { department: r.department, d }
  }
  return best
}

// The cluster's full name ("Physical infrastructure") is the widest header
// in the table and pushed it past a half-width panel; the panel note names
// it, so the header takes the short form.
const clusterLabel = computed(() =>
  props.history.providers.some((p) => cluster(p) !== null) ? 'Infra' : 'Infrastructure',
)
const days = computed(
  () => props.history.providers.find((p) => p.compare)?.compare?.days ?? props.history.window_days,
)

const columns = computed<TableColumn[]>(() => [
  { key: 'display', label: 'Lab', class: 'whitespace-nowrap' },
  { key: 'open', label: 'Open roles', numeric: true },
  { key: 'delta', label: `Δ ${days.value}d`, numeric: true },
  { key: 'cluster', label: clusterLabel.value, numeric: true },
  { key: 'cluster_delta', label: 'Δ', numeric: true },
  { key: 'mover', label: 'Moved most', class: 'text-xs' },
  { key: 'source', label: 'Source', keep: true },
])

const hasRows = (p: HiringHistoryProvider) => p.feed === 'ok' && p.total.length > 0
</script>

<template>
  <TerminalTable
    caption="Open roles per lab, the change over the comparison window, infrastructure roles, and the department that moved most"
    :columns="columns"
    :rows="history.providers"
    :row-key="(p) => p.provider"
    :gap="(p) => !hasRows(p)"
  >
    <template #cell-display="{ row: p }">
      <NuxtLink :to="`/hiring#${p.provider}`" class="hover:underline hover:underline-offset-2">
        {{ p.display }}
      </NuxtLink>
      <TerminalCaveatMark v-if="p.caveat" label="blended board" :text="p.caveat" class="ml-2" />
    </template>
    <template #cell-open="{ row: p }">
      <span class="text-highlighted">{{ count(p.total.at(-1)!) }}</span>
    </template>
    <template #cell-delta="{ row: p }">
      {{ p.compare ? signed(p.compare.total_now - p.compare.total_then) : '—' }}
    </template>
    <template #cell-cluster="{ row: p }">{{ cluster(p) ? count(cluster(p)!.now) : '—' }}</template>
    <template #cell-cluster_delta="{ row: p }">
      {{
        cluster(p) && cluster(p)!.then !== null ? signed(cluster(p)!.now - cluster(p)!.then!) : '—'
      }}
    </template>
    <template #cell-mover="{ row: p }">
      <template v-if="topMover(p)">
        {{ topMover(p)!.department }}
        <span class="ml-1 font-mono text-muted">{{ signed(topMover(p)!.d) }}</span>
      </template>
      <span v-else class="text-muted">none</span>
    </template>
    <template #cell-source="{ row: p }">
      <TerminalSources :sources="p.sources.slice(0, 1)" />
    </template>
    <template #gap="{ row: p }">
      <TerminalGap inline v-bind="feedGap('hiring', p) ?? { title: 'No parsed roles yet' }" />
    </template>
  </TerminalTable>
</template>
