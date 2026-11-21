<script setup lang="ts">
// Forward calls: dated estimates of a figure not yet filed, one row per
// method, each scored once the filing prints the actual. The inputs as they
// stood sit one click away.

import type { ForwardCallView, ForwardInput } from '../../../shared/utils/signals'
import { grouped, signedPercent, trimmed } from '../../../shared/utils/terminal-format'
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

const RULE: Record<ForwardCallView['rule'], string> = {
  hand: 'Registered by hand',
  'guidance-bias': 'Recorded by the guidance rule',
  'prints-ratio': 'Recorded by the prints rule',
}

const max = (c: ForwardCallView) =>
  Math.max(...c.methods.map((m) => m.high ?? m.value), c.actual?.value ?? 0)

const estimate = (m: ForwardCallView['methods'][number]) =>
  m.low !== null && m.high !== null && m.low !== m.high
    ? `${figures.usd(m.low)}–${figures.usd(m.high)}`
    : figures.usd(m.value)

const pct = (n: number | null) => (n === null ? '' : signedPercent(n))

function inputValue(i: ForwardInput): string {
  if (i.value === null) return 'held'
  if (i.unit === 'USD') return figures.usd(i.value)
  if (i.unit === 'share') return signedPercent(i.value * 100)
  if (i.unit === 'ratio') return trimmed(i.value, 3)
  return `${i.unit} ${grouped(i.value)}`
}

const recorded = (c: ForwardCallView) =>
  c.recorded.length > 10 ? stamps.dated(c.recorded) : stamps.date(c.recorded)

const calls = computed(() => props.calls)
</script>

<template>
  <div class="space-y-8">
    <section
      v-for="c in calls"
      :id="`call-${c.id}`"
      :key="c.id"
      :aria-labelledby="`call-${c.id}-heading`"
      class="space-y-2"
    >
      <h3 :id="`call-${c.id}-heading`" class="text-sm text-highlighted">
        {{ c.label }} <span class="font-mono text-muted">{{ c.ticker }}</span>
      </h3>
      <p class="text-xs text-muted">
        {{ RULE[c.rule] }}, {{ recorded(c) }}.
        <template v-if="c.actual">
          Filed {{ stamps.date(c.actual.filed) }} ({{ c.actual.form }}):
          <a :href="c.actual.filing_url" class="underline" target="_blank" rel="noopener">{{
            figures.usd(c.actual.value)
          }}</a
          >, {{ c.actual.in_range ? 'inside' : 'outside' }} the call’s range.
        </template>
        <template v-else>Scored when the filing for the period prints.</template>
      </p>
      <TerminalTable
        :caption="`${c.label}: each method’s estimate`"
        :columns="columns"
        :rows="c.methods"
        :row-key="(r) => r.method"
        nested
      >
        <template #cell-method="{ row }">
          {{ row.method }}
          <span v-if="row.control" class="ml-1 text-xs text-muted">(control)</span>
        </template>
        <template #cell-bar="{ row }">
          <TerminalBar :value="row.value" :max="max(c)" tone="primary" />
        </template>
        <template #cell-value="{ row }">{{ estimate(row) }}</template>
        <template #cell-error="{ row }">{{ pct(row.error_pct) }}</template>
      </TerminalTable>
      <p class="text-xs text-muted">{{ c.note }}</p>
      <TerminalExpand
        v-if="c.inputs.length"
        :show="`The ${c.inputs.length} inputs as they stood`"
        hide="Hide the inputs"
      >
        <ul class="space-y-1 text-xs text-muted">
          <li v-for="(i, n) in c.inputs" :key="n">
            {{ i.label }}:
            <a
              v-if="i.source_url"
              :href="i.source_url"
              class="underline"
              target="_blank"
              rel="noopener"
              >{{ inputValue(i) }}</a
            ><template v-else>{{ inputValue(i) }}</template>
            <template v-if="i.as_of">, {{ stamps.date(i.as_of.slice(0, 10)) }}</template>
          </li>
        </ul>
      </TerminalExpand>
    </section>
  </div>
</template>
