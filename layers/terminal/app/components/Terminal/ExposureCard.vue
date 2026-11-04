<script setup lang="ts">
// One filer's chart on /exposure: the series that share a chart id (a cash
// capex line and its finance-lease line, a total backlog and its cloud
// figure), a quarter per column, and the same numbers as a table one click
// away with the filing behind each value. A flow is charted by quarter only;
// a longer period the filer tags without a quarter (Amazon's nine-month
// marks) is in the table, labelled with its length.

import { compactUsd, count } from '../../../shared/utils/terminal-format'
import type { ExposurePoint, ExposureSeries } from '../../../shared/utils/terminal-exposure'
import type { CaveatRef, Citation, TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ id: string; title: string; series: ExposureSeries[] }>()

const unit = computed(() => props.series[0]?.unit ?? 'USD')

const fmt = (v: number) =>
  unit.value === 'USD'
    ? compactUsd(v)
    : unit.value === 'pure'
      ? `${Math.round(v * 1000) / 10}%`
      : `${count(v)}${unit.value === 'shares' ? ' shares' : ''}`

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ’${d.slice(2, 4)}`

const charted = (p: ExposurePoint) => p.months === null || p.months === 3

const x = computed(() =>
  [...new Set(props.series.flatMap((s) => s.points.filter(charted).map((p) => p.end)))].sort(),
)
const chartSeries = computed(() =>
  props.series.map((s) => {
    const at = new Map(s.points.filter(charted).map((p) => [p.end, p.value]))
    return { id: s.id, label: s.label, values: x.value.map((e) => at.get(e) ?? null) }
  }),
)

const period = (p: ExposurePoint) =>
  p.months === null
    ? `at ${p.end}`
    : p.months === 3
      ? `quarter to ${p.end}`
      : `${p.months} months to ${p.end}`

const latest = computed(() =>
  props.series
    .map((s) => ({ s, p: s.points.at(-1) }))
    .filter((r): r is { s: ExposureSeries; p: ExposurePoint } => Boolean(r.p)),
)

const columns = computed<TableColumn[]>(() => [
  { key: 'period', label: 'Period', class: 'whitespace-nowrap' },
  ...props.series.map((s) => ({ key: s.id, label: s.label, numeric: true })),
  { key: 'filing', label: 'Filing', class: 'whitespace-nowrap text-muted' },
])

interface Row {
  key: string
  period: string
  filing: ExposurePoint
  derived: boolean
  [series: string]: unknown
}

const rows = computed<Row[]>(() => {
  const byKey = new Map<string, Row>()
  for (const s of props.series) {
    for (const p of s.points) {
      const key = `${p.start ?? ''}|${p.end}`
      const row = byKey.get(key) ?? { key, period: period(p), filing: p, derived: false }
      row[s.id] = fmt(p.value)
      if (p.derived) row.derived = true
      if (p.filed > row.filing.filed) row.filing = p
      byKey.set(key, row)
    }
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? 1 : -1))
})

const superseded = computed(() => props.series.flatMap((s) => s.superseded.map((x) => ({ s, x }))))

const sources = computed<Citation[]>(() => {
  const seen = new Map<string, Citation>()
  for (const { p } of latest.value) {
    seen.set(p.source_url, {
      source_url: p.source_url,
      fetched_at: p.fetched_at,
      label: p.source_url.includes('companyfacts') ? 'EDGAR company facts' : `${p.form} XBRL`,
    })
  }
  return [...seen.values()]
})

const caveats = computed<CaveatRef[]>(() =>
  props.series
    .filter((s) => s.note)
    .map((s) => ({ text: s.note!, label: props.series.length > 1 ? s.label : 'about this line' })),
)

const tagLine = computed(() =>
  props.series.map((s) => `${s.concept}${s.dims ? ` on ${s.dims}` : ''}`).join('; '),
)
</script>

<template>
  <TerminalCard :id="id" :title="title" :sources="sources">
    <template #meta>
      <span>{{ series[0]?.kind === 'flow' ? 'per quarter' : 'at period end' }}</span>
    </template>

    <dl class="grid gap-x-6 gap-y-1 sm:grid-cols-2">
      <div v-for="{ s, p } in latest" :key="s.id" class="min-w-0">
        <dt class="text-xs text-muted">{{ s.label }}</dt>
        <dd class="font-mono text-lg text-highlighted tabular-nums">
          {{ fmt(p.value) }}
          <span class="font-sans text-xs text-muted">{{ period(p) }}</span>
        </dd>
      </div>
    </dl>

    <TerminalLineChart
      v-if="x.length > 1"
      :x="x"
      :series="chartSeries"
      :format="fmt"
      :x-label="monthLabel"
      :title="`${title}: ${chartSeries.map((s) => s.label).join(', ')}, ${series[0]?.kind === 'flow' ? 'per quarter' : 'at each period end'}, ${monthLabel(x[0]!)} to ${monthLabel(x.at(-1)!)}`"
    />

    <TerminalExpand show="Every period, with its filing" hide="Hide the table">
      <TerminalTable
        :caption="`${title}, every period, newest first`"
        :columns="columns"
        :rows="rows"
        :row-key="(r) => r.key"
        nested
      >
        <template #cell-period="{ row: r }">
          {{ r.period }}
          <span
            v-if="r.derived"
            class="text-muted"
            title="Year to date less the figure a quarter shorter"
          >
            · derived</span
          >
        </template>
        <template #cell-filing="{ row: r }">
          <a
            :href="r.filing.filing_url"
            target="_blank"
            rel="noopener noreferrer"
            class="underline underline-offset-2 hover:text-default"
            >{{ r.filing.form }} {{ r.filing.filed }}</a
          >
        </template>
      </TerminalTable>
      <p class="text-xs text-muted">
        Read from <code>{{ tagLine }}</code
        >. A derived quarter is the filing’s year-to-date figure less the one a quarter shorter.
      </p>
      <div v-if="superseded.length" class="space-y-1 text-xs text-muted">
        <p>Restated by a later filing:</p>
        <ul class="space-y-0.5">
          <li
            v-for="{ s, x: r } in superseded"
            :key="`${s.id}|${r.accession_no}|${r.start}|${r.end}`"
          >
            {{ s.label }}, {{ r.start ? `${r.start} to ${r.end}` : `at ${r.end}` }}:
            <span class="font-mono">{{ fmt(r.value) }}</span> in the
            <a
              :href="r.filing_url"
              target="_blank"
              rel="noopener noreferrer"
              class="underline underline-offset-2 hover:text-default"
              >{{ r.form }} filed {{ r.filed }}</a
            >
          </li>
        </ul>
      </div>
    </TerminalExpand>

    <template #foot>
      <TerminalCaveatMark v-for="c in caveats" :key="c.text" :label="c.label" :text="c.text" />
    </template>
  </TerminalCard>
</template>
