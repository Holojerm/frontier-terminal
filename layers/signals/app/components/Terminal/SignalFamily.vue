<script setup lang="ts">
// One wave of the alpha program: every cell it registered before it ran,
// against its own family's bar and the all-tests bar side by side, so a cell
// that clears only the smaller family reads as that and no more.

import type { SignalFamilyCell, SignalFamilyView, SignalsData } from '../../../shared/utils/signals'

const props = defineProps<{ data: SignalsData; family: SignalFamilyView }>()

const labels = computed(() => new Map(props.data.series.map((s) => [s.id, s.label])))

const fmtStat = (stat: SignalStat | undefined) => {
  if (!stat || stat.status !== 'ok' || stat.estimate === null) return 'not enough history'
  const p =
    stat.p_value === null
      ? ''
      : stat.p_value < 0.001
        ? ', p < 0.001'
        : `, p ${grouped(stat.p_value, 3)}`
  return `r ${grouped(stat.estimate, 2)}${p}`
}

const verdict = (c: SignalFamilyCell) => {
  if (!c.cell || c.cell.out.status !== 'ok') return 'Waiting'
  if (signalFamilyCellHolds(c, props.data.bonferroni_p)) return 'Holds, both bars'
  if (signalFamilyCellHolds(c, props.family.bonferroni_p)) return 'Holds, wave bar only'
  return 'Doesn’t hold'
}

const columns: TableColumn[] = [
  { key: 'series', label: 'Series' },
  { key: 'ticker', label: 'Ticker', stack: 'inline' },
  { key: 'horizon', label: 'Horizon', stack: 'inline' },
  { key: 'direction', label: 'Predicted', stack: 'inline' },
  { key: 'out', label: 'Held out', hint: 'in sample below', class: 'sm:whitespace-nowrap' },
  { key: 'verdict', label: 'Result' },
]

const bar = (p: number | null, n: number) =>
  p === null ? 'no tests yet' : `0.05 / ${n} = ${p.toPrecision(2)}`

const note = computed(
  () =>
    `Registered ${props.family.registered}. Wave bar ${bar(props.family.bonferroni_p, props.family.tests)}; all-tests bar ${bar(props.data.bonferroni_p, props.data.tests)}. ${props.family.holds} of ${props.family.cells.length} cells hold at the wave bar, ${props.family.holds_all} at both.`,
)
</script>

<template>
  <div>
    <p class="border-b border-default p-3 text-xs text-muted">{{ note }}</p>
    <TerminalTable
      :caption="`${family.label}: every registered cell`"
      :columns="columns"
      :rows="family.cells"
      :row-key="(c) => `${c.series}|${c.ticker}|${c.horizon}`"
      align="top"
      flow
      stack
    >
      <template #cell-series="{ row }">
        <a :href="`#${row.series}`" class="text-highlighted">{{
          labels.get(row.series) ?? row.series
        }}</a>
      </template>
      <template #cell-ticker="{ row }">
        <span class="font-mono">{{ row.ticker }}</span>
      </template>
      <template #cell-horizon="{ row }">
        <span class="font-mono">{{ row.horizon }}d</span>
      </template>
      <template #cell-direction="{ row }">{{
        row.direction === 'up' ? 'Rises with it' : 'Falls as it rises'
      }}</template>
      <template #cell-out="{ row }">
        <span class="font-mono">{{ fmtStat(row.cell?.out) }}</span>
        <span class="block font-mono text-xs text-muted">({{ fmtStat(row.cell?.in) }})</span>
      </template>
      <template #cell-verdict="{ row }">
        <span :class="verdict(row).startsWith('Holds') ? 'text-primary' : 'text-muted'">{{
          verdict(row)
        }}</span>
      </template>
    </TerminalTable>
  </div>
</template>
