<script setup lang="ts">
// MLPerf rounds side by side: per chip and benchmark at one accelerator
// count, each round's fastest result per accelerator and the change since the
// round before. A table, since each chip has a point per round and two rounds
// are stored. Every figure carries its result ID, the word "unverified" the
// Results Messaging Guidelines put beside each score, and the footnote.

import { count, pctLabel } from '../../../shared/utils/terminal-format'
import type { UtilizationData } from '../../../shared/utils/recipe-views'
import type { TableColumn } from '../../types/terminal-ui'

type Rounds = NonNullable<UtilizationData['benchmark_rounds']>

const props = defineProps<{ rounds: Rounds }>()

const columns = computed<TableColumn[]>(() => [
  { key: 'model', label: 'Benchmark', class: 'font-mono' },
  { key: 'accelerators', label: 'Accelerators', numeric: true, hint: 'per system' },
  ...props.rounds.rounds.map((round, i) => ({
    key: `round${i}`,
    label: round,
    numeric: true,
    hint: 'tokens/s per accelerator',
  })),
  { key: 'change', label: 'Change', numeric: true },
])

const rows = computed(() =>
  props.rounds.rows.map((r) => ({
    key: `${r.accelerator}|${r.model}|${r.accelerators}`,
    accelerator: r.accelerator,
    model: r.model,
    accelerators: count(r.accelerators),
    results: r.results,
    change: pctLabel(r.change * 100),
    up: r.change > 0,
    down: r.change < 0,
    ...Object.fromEntries(r.results.map((x, i) => [`round${i}`, x])),
  })),
)
const roundKeys = computed(() => props.rounds.rounds.map((_, i) => `round${i}`))

const leftOut = computed(() => {
  const chips = props.rounds.accelerators_left_out
  const mixed = props.rounds.mixed_results
  const chipText = `${count(chips)} ${chips === 1 ? 'accelerator has' : 'accelerators have'} no like-for-like result in another round`
  const mixedText = `${count(mixed)} ${mixed === 1 ? 'result' : 'results'} from systems that mix accelerators`
  if (chips && mixed)
    return `${chipText} and ${chips === 1 ? 'is' : 'are'} left out, as are ${mixedText}.`
  if (chips) return `${chipText} and ${chips === 1 ? 'is' : 'are'} left out.`
  if (mixed) return `${mixedText} ${mixed === 1 ? 'is' : 'are'} left out.`
  return ''
})
</script>

<template>
  <div class="space-y-3">
    <TerminalTable
      caption="MLPerf Inference tokens per second per accelerator in each stored round, per accelerator and benchmark at the same accelerator count, unverified by MLCommons"
      :columns="columns"
      :rows="rows"
      :row-key="(r) => r.key"
      :group="(r) => r.accelerator"
      nested
      stack
    >
      <template v-for="(key, i) in roundKeys" :key="key" #[`cell-${key}`]="{ row: r }">
        <span v-if="r.results[i]" class="inline-flex flex-col items-end">
          <span class="whitespace-nowrap font-mono text-highlighted">
            {{ count(Math.round(r.results[i].per_accelerator)) }}
          </span>
          <span class="whitespace-nowrap text-muted">
            {{ r.results[i].result_id }}, unverified
          </span>
        </span>
        <span v-else class="text-muted">not run</span>
      </template>
      <template #cell-change="{ row: r }">
        <span
          class="whitespace-nowrap font-mono"
          :class="r.up ? 'text-success' : r.down ? 'text-error' : 'text-muted'"
        >
          {{ r.change }}
        </span>
      </template>
    </TerminalTable>

    <p class="text-xs text-muted">
      Each row compares systems of one size: the same accelerator, at the same count, in every
      round. {{ leftOut }}
    </p>

    <TerminalSources
      :sources="rounds.sources"
      :caveats="[{ text: rounds.method, label: 'method' }]"
    >
      <span>Apache 2.0, MLCommons</span>
    </TerminalSources>
    <p class="text-xs text-toned">{{ rounds.footnote }}</p>
  </div>
</template>
