<script setup lang="ts">
// The hardware layer's monthly prints (/api/prints): one row per company with
// its newest month, the change on a year earlier as the release states it,
// the last two years as a sparkline and when we first held the figure; then
// the quoted ties naming who each company builds for or supplies.

import type { PrintsData } from '../../../shared/utils/prints'
import { grouped, signedPercent } from '../../../shared/utils/terminal-format'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ data: PrintsData }>()
const stamps = useStamps()

const columns: TableColumn[] = [
  { key: 'company', label: 'Company' },
  { key: 'month', label: 'Month' },
  { key: 'revenue', label: 'Revenue', numeric: true, hint: 'NT$ billion' },
  { key: 'yoy', label: 'YoY', numeric: true },
  { key: 'trend', label: '24 months' },
  { key: 'seen', label: 'First seen' },
]

const rows = computed(() =>
  props.data.series
    .filter((s) => s.entity.series === 'tw_revenue')
    .map((s) => {
      const months = s.points.filter((p) => p.window === 'month')
      const newest = months[0] ?? null
      return {
        key: s.entity.id,
        name: s.entity.name,
        ticker: s.entity.us_ticker ? `${s.entity.ticker} · ${s.entity.us_ticker}` : s.entity.ticker,
        newest,
        spark: months
          .slice(0, 24)
          .toReversed()
          .map((p) => p.value),
        revisions: s.revisions,
      }
    }),
)

const tieColumns: TableColumn[] = [
  { key: 'company', label: 'Company' },
  { key: 'counterparty', label: 'Names' },
  { key: 'quote', label: 'Quote' },
  { key: 'source', label: 'Source' },
]
const ties = computed(() =>
  props.data.series.flatMap((s) =>
    s.ties.map((t, i) => ({ ...t, key: `${t.entity}-${t.ticker}-${i}` })),
  ),
)

const sources = computed(() => {
  const seen = new Map<string, { source_url: string; fetched_at: string }>()
  for (const s of props.data.series) {
    for (const p of s.points.slice(0, 1))
      seen.set(p.source_url, { source_url: p.source_url, fetched_at: p.first_seen_at })
  }
  return [...seen.values()]
})

const billions = (v: number) => grouped(v / 1e9, 1)
</script>

<template>
  <div class="space-y-4">
    <TerminalTable
      caption="Monthly revenue of the Taiwan foundry, server, networking and power companies, newest month"
      :columns="columns"
      :rows="rows"
      :row-key="(r) => r.key"
      :gap="(r) => r.newest === null"
      :gap-columns="['month', 'revenue', 'yoy', 'trend', 'seen']"
      nested
      stack
    >
      <template #cell-company="{ row: r }">
        <span class="text-highlighted">{{ r.name }}</span>
        <span class="ml-2 font-mono text-xs text-muted">{{ r.ticker }}</span>
      </template>
      <template #cell-month="{ row: r }">{{ r.newest?.period }}</template>
      <template #cell-revenue="{ row: r }">
        <span v-if="r.newest">{{ billions(r.newest.value) }}</span>
      </template>
      <template #cell-yoy="{ row: r }">
        {{ r.newest?.yoy_pct == null ? '—' : signedPercent(r.newest.yoy_pct) }}
      </template>
      <template #cell-trend="{ row: r }">
        <TerminalSparkline v-if="r.spark.length > 1" :values="r.spark" />
        <span v-else class="text-muted">—</span>
      </template>
      <template #cell-seen="{ row: r }">
        <span v-if="r.newest" class="text-xs text-muted">
          {{ stamps.absolute(r.newest.published_at ?? r.newest.first_seen_at) }}
        </span>
      </template>
      <template #gap>
        <span class="text-sm text-muted">No month read yet.</span>
      </template>
    </TerminalTable>

    <TerminalExpand
      v-if="ties.length"
      :show="`Show the ${ties.length} quoted ties`"
      hide="Hide the ties"
    >
      <TerminalTable
        caption="Filings and company statements naming who each company builds for or supplies"
        :columns="tieColumns"
        :rows="ties"
        :row-key="(r) => r.key"
        nested
        stack
      >
        <template #cell-company="{ row: r }">
          {{ r.company }}<span v-if="r.via" class="text-muted">, through {{ r.via }}</span>
        </template>
        <template #cell-quote="{ row: r }">
          <span class="text-sm">“{{ r.quote }}”</span>
        </template>
        <template #cell-source="{ row: r }">
          <TerminalSources
            :sources="[
              { source_url: r.source_url, fetched_at: r.fetched_at, label: r.source_title },
            ]"
          />
        </template>
      </TerminalTable>
    </TerminalExpand>

    <TerminalGap v-for="g in data.gaps" :key="g.id" :title="g.title" :reason="g.reason" inline />

    <TerminalSources :sources="sources">
      <span>TWSE data under the Open Government Data License, version 1.0</span>
    </TerminalSources>
  </div>
</template>
