<script setup lang="ts">
// What a parent tags on a lab, as a table: each line's newest value and the
// period it covers, and every earlier value one click away. Used on /exposure
// for the lines too short or too irregular to chart (a stake, a commitment,
// a nine-month mark).

import { compactUsd, count } from '../../../shared/utils/terminal-format'
import type { ExposurePoint, ExposureSeries } from '../../../shared/utils/terminal-exposure'
import type { CaveatRef, Citation, TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ id: string; title: string; series: ExposureSeries[] }>()

const fmt = (s: ExposureSeries, v: number) =>
  s.unit === 'USD'
    ? compactUsd(v)
    : s.unit === 'pure'
      ? `${Math.round(v * 1000) / 10}%`
      : `${count(v)}${s.unit === 'shares' ? ' shares' : ''}`

const period = (p: ExposurePoint) =>
  p.months === null
    ? `at ${p.end}`
    : p.months === 3
      ? `quarter to ${p.end}`
      : `${p.months} months to ${p.end}`

const columns: TableColumn[] = [
  { key: 'label', label: 'Line' },
  { key: 'period', label: 'Period', class: 'whitespace-nowrap' },
  { key: 'value', label: 'As filed', numeric: true },
  { key: 'filing', label: 'Filing', class: 'whitespace-nowrap text-muted' },
]

const rowOf = (s: ExposureSeries, p: ExposurePoint) => ({
  key: `${s.id}|${p.start ?? ''}|${p.end}`,
  label: s.label,
  period: period(p),
  value: fmt(s, p.value),
  derived: p.derived,
  filing: p,
})

const latest = computed(() =>
  props.series.filter((s) => s.points.length).map((s) => rowOf(s, s.points.at(-1)!)),
)
const every = computed(() =>
  props.series.flatMap((s) => [...s.points].reverse().map((p) => rowOf(s, p))),
)

const sources = computed<Citation[]>(() => {
  const seen = new Map<string, Citation>()
  for (const s of props.series) {
    const p = s.points.at(-1)
    if (p)
      seen.set(p.source_url, {
        source_url: p.source_url,
        fetched_at: p.fetched_at,
        label: `${p.form} XBRL`,
      })
  }
  return [...seen.values()]
})

const caveats = computed<CaveatRef[]>(() =>
  props.series.filter((s) => s.note).map((s) => ({ text: s.note!, label: s.label })),
)
</script>

<template>
  <TerminalCard :id="id" :title="title" :sources="sources">
    <TerminalTable
      :caption="`${title}: each line’s newest value`"
      :columns="columns"
      :rows="latest"
      :row-key="(r) => r.key"
      nested
    >
      <template #cell-period="{ row: r }">
        {{ r.period }}<span v-if="r.derived" class="text-muted"> · derived</span>
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

    <TerminalExpand
      v-if="every.length > latest.length"
      show="Every value, with its filing"
      hide="Hide the history"
    >
      <TerminalTable
        :caption="`${title}: every value, newest first per line`"
        :columns="columns"
        :rows="every"
        :row-key="(r) => r.key"
        nested
      >
        <template #cell-period="{ row: r }">
          {{ r.period }}<span v-if="r.derived" class="text-muted"> · derived</span>
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
    </TerminalExpand>

    <template #foot>
      <TerminalCaveatMark v-for="c in caveats" :key="c.text" :label="c.label" :text="c.text" />
    </template>
  </TerminalCard>
</template>
