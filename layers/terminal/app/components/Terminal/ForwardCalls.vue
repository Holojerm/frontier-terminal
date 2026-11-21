<script setup lang="ts">
// Forward calls: dated estimates of a figure not yet filed, one row per
// method, each scored once the filing prints the actual.

import type { ForwardCallView } from '../../../shared/utils/signals'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ calls: ForwardCallView[] }>()

const figures = useFigures()
const stamps = useStamps()

const columns: TableColumn[] = [
  { key: 'method', label: 'Method' },
  { key: 'bar', label: 'Scale', class: 'w-32' },
  { key: 'value', label: 'Estimate', numeric: true },
  { key: 'error', label: 'Off the actual', numeric: true },
]

const max = (c: ForwardCallView) =>
  Math.max(...c.methods.map((m) => m.value), c.prior.value, c.actual?.value ?? 0)

const rowsOf = (c: ForwardCallView) => [
  ...c.methods.map((m) => ({ ...m, key: m.method, prior: false })),
  {
    method: `${c.prior.label} actual`,
    value: c.prior.value,
    control: false,
    error_pct: null,
    key: 'prior',
    prior: true,
  },
]

const pct = (n: number | null) => (n === null ? '' : signedPercent(n))

const calls = computed(() => props.calls)
</script>

<template>
  <div class="space-y-6">
    <section v-for="c in calls" :key="c.id" :aria-labelledby="`call-${c.id}`" class="space-y-2">
      <h3 :id="`call-${c.id}`" class="text-sm text-highlighted">
        {{ c.label }} <span class="font-mono text-muted">{{ c.ticker }}</span>
      </h3>
      <p class="text-xs text-muted">
        Recorded {{ stamps.date(c.recorded) }}.
        <template v-if="c.actual">
          Filed {{ stamps.date(c.actual.filed) }}:
          <a :href="c.actual.filing_url" class="underline" target="_blank" rel="noopener">{{
            figures.usd(c.actual.value)
          }}</a
          >.
        </template>
        <template v-else>Scored when the filing for the quarter prints.</template>
      </p>
      <TerminalTable
        :caption="`${c.label}: each method’s estimate`"
        :columns="columns"
        :rows="rowsOf(c)"
        :row-key="(r) => r.key"
        nested
      >
        <template #cell-method="{ row }">
          <span :class="row.prior ? 'text-muted' : ''">{{ row.method }}</span>
          <span v-if="row.control" class="ml-1 text-xs text-muted">(control)</span>
        </template>
        <template #cell-bar="{ row }">
          <TerminalBar :value="row.value" :max="max(c)" :tone="row.prior ? 'neutral' : 'primary'" />
        </template>
        <template #cell-value="{ row }">{{ figures.usd(row.value) }}</template>
        <template #cell-error="{ row }">{{ pct(row.error_pct) }}</template>
      </TerminalTable>
      <p class="text-xs text-muted">{{ c.prior.label }}: {{ c.prior.basis }}. {{ c.note }}</p>
    </section>
  </div>
</template>
