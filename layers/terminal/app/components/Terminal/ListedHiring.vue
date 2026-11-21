<script setup lang="ts">
// Hiring at the listed companies around the labs (/api/hiring/listed): one
// row per board with its newest read and the change on the week before, and
// the data-center roles per week once there are two. The boards we don't
// read are one line each under the table.

import { count, signed } from '../../../shared/utils/terminal-format'
import { dayLabel } from '../../../shared/utils/thesis-format'
import type { ListedHiringData } from '../../../shared/utils/listed-hiring'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ data: ListedHiringData }>()

const columns: TableColumn[] = [
  { key: 'ticker', label: 'Ticker' },
  { key: 'company', label: 'Company' },
  { key: 'total', label: 'Open roles', numeric: true },
  { key: 'datacenter', label: 'Data-center', numeric: true },
  { key: 'dc_change', label: 'Δ week', numeric: true },
  { key: 'infrastructure', label: 'Infra', numeric: true },
  { key: 'source', label: 'Source', keep: true },
]

const rows = computed(() =>
  props.data.boards.map((b) => {
    const week = b.weeks.at(-1)
    return { ...b, week }
  }),
)

const weeks = computed(() =>
  [...new Set(props.data.boards.flatMap((b) => b.weeks.map((w) => w.week)))].sort(),
)

const chart = computed(() => ({
  x: weeks.value,
  series: props.data.boards
    .filter((b) => b.host && b.weeks.length > 0)
    .map((b) => {
      const at = new Map(b.weeks.map((w) => [w.week, w.datacenter]))
      return { id: b.ticker, label: b.ticker, values: weeks.value.map((w) => at.get(w) ?? null) }
    }),
}))

const cell = (n: number | null | undefined) => (n === null || n === undefined ? '—' : count(n))
</script>

<template>
  <div class="space-y-3">
    <TerminalLineChart
      v-if="chart.series.length && chart.x.length > 1"
      :x="chart.x"
      :series="chart.series"
      :format="count"
      :x-label="dayLabel"
      :title="`Open data-center roles per week at ${chart.series.map((s) => s.label).join(', ')} from ${chart.x[0]} to ${chart.x.at(-1)}`"
    />
    <TerminalTable
      caption="Open roles on each listed company’s job board at its newest read, with data-center and infrastructure roles"
      :columns="columns"
      :rows="rows"
      :row-key="(r) => r.id"
      nested
    >
      <template #cell-ticker="{ row: r }">
        <span :id="`listed-${r.ticker}`" class="font-mono text-highlighted">{{ r.ticker }}</span>
      </template>
      <template #cell-company="{ row: r }">
        {{ r.company }}
        <TerminalCaveatMark v-if="r.caveat" label="about this board" :text="r.caveat" />
      </template>
      <template #cell-total="{ row: r }">{{ r.latest ? cell(r.latest.total) : '—' }}</template>
      <template #cell-datacenter="{ row: r }">
        <span :class="r.host ? 'text-highlighted' : 'text-muted'">{{
          r.latest ? cell(r.latest.datacenter) : '—'
        }}</span>
      </template>
      <template #cell-dc_change="{ row: r }">{{
        r.week && r.week.datacenter_change !== null ? signed(r.week.datacenter_change) : '—'
      }}</template>
      <template #cell-infrastructure="{ row: r }">{{
        r.latest ? cell(r.latest.infrastructure) : '—'
      }}</template>
      <template #cell-source="{ row: r }">
        <TerminalProvenanceTag
          v-if="r.latest"
          :source-url="r.latest.source_url"
          :fetched-at="r.latest.fetched_at"
          label="Board"
        />
        <span v-else class="text-muted">Not read yet</span>
      </template>
    </TerminalTable>
    <p class="flex flex-wrap items-center gap-x-2 text-xs text-muted">
      <TerminalCaveatMark label="how roles are classed" :text="data.rule" />
      <span>A chip or connectivity maker’s data-center roles mostly sell to data centers.</span>
    </p>
    <TerminalExpand v-if="data.cut.length" show="Boards we don’t read" hide="Hide">
      <ul class="space-y-1 text-xs">
        <li v-for="c in data.cut" :key="c.ticker">
          <span class="mr-1 font-mono text-default">{{ c.ticker }}</span>
          <span class="text-muted">{{ c.reason }}</span>
        </li>
      </ul>
    </TerminalExpand>
  </div>
</template>
