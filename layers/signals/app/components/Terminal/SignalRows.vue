<script setup lang="ts">
// One run of scorecard rows: a series, what it measures, the tickers it is
// tested against, its history, and its held-out result at the ticker and
// horizon the scorecard picked, with the full grid of every ticker and horizon
// behind a toggle. A waiting run states what each series still needs in place
// of a result, never a number.

import type { SignalScorecardRow, SignalsData } from '../../../shared/utils/signals'

const props = defineProps<{
  data: SignalsData
  rows: SignalScorecardRow[]
  caption: string
  /** Series without a held-out result yet. */
  waiting?: boolean
}>()

const stamps = useStamps()

const fmtEstimate = (s: SignalSeriesView, stat: SignalStat) => {
  if (stat.estimate === null) return ''
  if (s.test === 'lead_lag') return `r ${grouped(stat.estimate, 2)}`
  return signedPercent(stat.estimate * 100)
}

const fmtP = (p: number | null) =>
  p === null ? '' : p < 0.001 ? 'p < 0.001' : `p ${grouped(p, 3)}`

const holds = (cell: SignalCell) => signalCellHolds(cell, props.data.bonferroni_p)

const columns = computed<TableColumn[]>(() => [
  { key: 'label', label: 'Series' },
  { key: 'entity', label: 'Measures', stack: 'inline' },
  { key: 'tickers', label: 'Tested against', class: 'min-w-40' },
  {
    key: 'history',
    label: 'History',
    hint: 'periods or event days',
    class: 'sm:whitespace-nowrap',
  },
  props.waiting
    ? { key: 'needs', label: 'Needs', hint: 'held out' }
    : {
        key: 'best',
        label: 'Best held out',
        hint: 'smallest p of its tests',
        class: 'sm:whitespace-nowrap',
      },
])

const GROUP: Record<SignalScorecardRow['verdict'], string> = {
  clears: 'Clear the bar held out',
  tested: 'Tested, don’t clear the bar',
  waiting: 'Waiting on history',
}

const needs = (s: SignalSeriesView) =>
  s.test === 'event'
    ? `${props.data.min_sample.event.out} event days`
    : `${props.data.min_sample.lead_lag.out} periods`

const gridColumns = computed<TableColumn[]>(() => [
  { key: 'ticker', label: 'Ticker' },
  ...props.data.horizons.map((h) => ({
    key: `h${h}`,
    label: `${h} day${h === 1 ? '' : 's'}`,
    hint: 'held out (in sample)',
    numeric: true,
  })),
])

const statText = (s: SignalSeriesView, stat: SignalStat) =>
  stat.status === 'ok' ? `${fmtEstimate(s, stat)}, ${fmtP(stat.p_value)}` : `too few (n ${stat.n})`

/** One row per ticker, each horizon's held-out and in-sample text ready to print. */
const gridRows = (s: SignalSeriesView) =>
  s.tickers.map((ticker) => ({
    ticker,
    cells: Object.fromEntries(
      props.data.horizons.map((h) => {
        const c = s.cells.find((x) => x.ticker === ticker && x.horizon === h)
        return [
          `h${h}`,
          c
            ? { out: statText(s, c.out), in: statText(s, c.in), holds: holds(c) }
            : { out: '', in: '', holds: false },
        ]
      }),
    ) as Record<string, { out: string; in: string; holds: boolean }>,
  }))
</script>

<template>
  <TerminalTable
    :caption="caption"
    :columns="columns"
    :rows="rows"
    :row-key="(r) => r.id"
    :row-id="(r) => r.id"
    :group="waiting ? undefined : (r) => GROUP[r.verdict]"
    align="top"
    flow
    stack
  >
    <template #cell-label="{ row }">
      <span class="block text-highlighted">{{ row.label }}</span>
      <span class="block font-mono text-xs text-muted">{{ row.source }}</span>
      <TerminalExpand v-if="row.observations > 0" show="All tests" hide="Hide tests">
        <TerminalTable
          :caption="`${row.label}: every ticker and horizon`"
          :columns="gridColumns"
          :rows="gridRows(row)"
          :row-key="(g) => g.ticker"
          nested
        >
          <template v-for="h in data.horizons" :key="h" #[`cell-h${h}`]="{ row: g }">
            <span :class="g.cells[`h${h}`]?.holds ? 'text-primary' : ''">{{
              g.cells[`h${h}`]?.out
            }}</span>
            <span class="block text-muted">({{ g.cells[`h${h}`]?.in }})</span>
          </template>
        </TerminalTable>
      </TerminalExpand>
    </template>
    <template #cell-entity="{ row }">{{ row.entity.label }}</template>
    <template #cell-tickers="{ row }">
      <span class="font-mono">{{ row.tickers.join(' ') }}</span>
    </template>
    <template #cell-history="{ row }">
      <template v-if="row.error">
        <TerminalGap inline title="Couldn’t read" :reason="row.error" />
      </template>
      <template v-else>
        <span class="font-mono">{{ row.observations }}</span>
        <span v-if="row.from && row.to" class="block text-xs text-muted">
          {{ stamps.date(row.from) }} to {{ stamps.date(row.to) }}
        </span>
      </template>
    </template>
    <template #cell-best="{ row }">
      <template v-if="row.best">
        <span class="font-mono" :class="holds(row.best) ? 'text-primary' : ''">
          {{ row.best.ticker }} {{ row.best.horizon }}d {{ fmtEstimate(row, row.best.out) }}
        </span>
        <span class="block font-mono text-xs text-muted">
          {{ fmtP(row.best.out.p_value) }}, n {{ row.best.out.n }}
        </span>
      </template>
    </template>
    <template #cell-needs="{ row }">
      <span class="text-xs text-muted">{{ needs(row) }}</span>
    </template>
  </TerminalTable>
</template>
