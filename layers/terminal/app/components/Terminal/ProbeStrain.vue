<script setup lang="ts">
// Measured strain as one row per lab: our hourly probe of its flagship model,
// read as working-hours throughput against night and the share of probes rate
// limited or failed, over the trailing window of complete days. A lab with no
// reading yet, or none possible, is a row that says why.

import { grouped, pctLabel } from '../../../shared/utils/terminal-format'
import type { ProbeLabView, ProbesData } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ probes: ProbesData }>()

const watchlist = useWatchlist()
const stamps = useStamps()

const columns = computed<TableColumn[]>(() => [
  { key: 'display', label: 'Lab', class: 'whitespace-nowrap' },
  { key: 'model', label: 'Model', class: 'whitespace-nowrap font-mono text-xs' },
  { key: 'peak', label: 'Peak', hint: 'tokens/s', numeric: true },
  { key: 'offpeak', label: 'Off-peak', hint: 'tokens/s', numeric: true },
  { key: 'ratio', label: 'Peak vs off-peak', numeric: true },
  {
    key: 'strained',
    label: 'Limited or failed',
    hint: `last ${props.probes.window_days}d`,
    numeric: true,
  },
  { key: 'last', label: 'Last probe', class: 'whitespace-nowrap text-xs' },
  { key: 'source', label: 'Read from', keep: true },
])

/** The model id without the router's vendor prefix. */
const modelName = (id: string) => id.slice(id.indexOf('/') + 1)

const speed = (tps: number | null) => (tps === null ? null : grouped(tps, 1))

/** A ratio of 0.8 reads as −20%: slower in working hours. */
const ratioLabel = (ratio: number | null) => (ratio === null ? null : pctLabel((ratio - 1) * 100))

const OUTCOME: Record<string, string> = {
  rate_limited: 'rate limited',
  failed: 'failed',
  timeout: 'timed out',
  setup: 'not counted',
  router: 'not counted',
}

function gapOf(lab: ProbeLabView): { title: string; reason: string } {
  if (lab.status === 'not_probed') return { title: 'Not probed', reason: lab.gap ?? '' }
  if (lab.status === 'waiting') return { title: 'No probe yet', reason: lab.gap ?? '' }
  if (lab.other_series.length > 0) {
    return {
      title: 'First full day pending',
      reason: `Probes now leave from one place, in ${props.probes.placement.label}. A reading needs one complete UTC day from there; earlier probes are kept apart.`,
    }
  }
  return {
    title: 'First full day pending',
    reason: 'A reading needs one complete UTC day of probes. The first probes are in.',
  }
}
</script>

<template>
  <TerminalTable
    caption="Hourly latency probes per lab: working-hours throughput against night, and the share of probes rate limited or failed"
    :columns="columns"
    :rows="watchlist.first(probes.labs, (l) => l.lab)"
    :row-key="(l) => l.lab"
    :gap="(l) => l.window === null"
  >
    <template #cell-model="{ row: l }">
      {{ modelName(l.model) }}
      <TerminalCaveatMark
        v-if="l.model_note"
        :name="`Why ${l.display} is probed on this model`"
        :text="l.model_note"
      />
    </template>
    <template #cell-peak="{ row: l }">
      <span v-if="speed(l.window!.peak_tps)" class="text-highlighted">{{
        speed(l.window!.peak_tps)
      }}</span>
      <span v-else class="font-sans text-xs text-muted">too few</span>
    </template>
    <template #cell-offpeak="{ row: l }">
      <template v-if="speed(l.window!.offpeak_tps)">{{ speed(l.window!.offpeak_tps) }}</template>
      <span v-else class="font-sans text-xs text-muted">too few</span>
    </template>
    <template #cell-ratio="{ row: l }">
      <span v-if="ratioLabel(l.window!.peak_to_offpeak)" class="text-highlighted">{{
        ratioLabel(l.window!.peak_to_offpeak)
      }}</span>
      <span v-else class="font-sans text-xs text-muted">too few</span>
      <TerminalCaveatMark
        v-if="l.hours"
        :name="`Hours counted as peak and off-peak for ${l.display}`"
        :text="`For ${l.display}: ${l.hours}.`"
      />
    </template>
    <template #cell-strained="{ row: l }">
      <span :class="l.window!.rate_limited + l.window!.failed > 0 ? 'text-warning' : undefined">{{
        l.window!.rate_limited + l.window!.failed
      }}</span>
      <span class="text-muted"> of {{ l.window!.probes }}</span>
    </template>
    <template #cell-last="{ row: l }">
      <template v-if="l.latest">
        <span v-if="l.latest.outcome === 'ok'" class="font-mono">
          {{ speed(l.latest.tokens_per_second) ?? '?' }} tokens/s<template
            v-if="l.latest.ttft_ms !== null"
          >
            · first token {{ grouped(l.latest.ttft_ms / 1000, 1) }}s</template
          >
        </span>
        <span v-else class="text-warning">{{ OUTCOME[l.latest.outcome] ?? l.latest.outcome }}</span>
        <span class="text-muted">
          ·
          <time :datetime="l.latest.started_at" :title="l.latest.started_at">{{
            stamps.relative(l.latest.started_at)
          }}</time>
        </span>
      </template>
    </template>
    <template #cell-source="{ row: l }">
      <TerminalProvenanceTag
        v-if="l.latest"
        :source-url="l.latest.source_url"
        :fetched-at="l.latest.fetched_at"
      />
    </template>
    <template #gap="{ row: l }">
      <TerminalGap inline v-bind="gapOf(l)" />
    </template>
  </TerminalTable>
</template>
