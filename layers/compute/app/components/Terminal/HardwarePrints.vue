<script setup lang="ts">
// The hardware layer's monthly prints (/api/prints): per company its newest month,
// change on a year, a two-year sparkline and first sighting; Korea's chip exports
// by window; UN Comtrade's HS 8542; and the quoted ties.

import type { PrintsData } from '../../../shared/utils/prints'

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
    .filter((s) => s.series === 'tw_revenue')
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

const krColumns: TableColumn[] = [
  { key: 'window', label: 'Period' },
  { key: 'month', label: 'Month' },
  { key: 'exports', label: 'Exports', numeric: true, hint: 'US$ billion' },
  { key: 'yoy', label: 'YoY', numeric: true },
  { key: 'seen', label: 'Released' },
]
const WINDOW_LABEL = { d10: 'First 10 days', d20: 'First 20 days', month: 'Whole month' } as const
const korea = computed(() => {
  const points = props.data.series.find((s) => s.series === 'kr_chip_exports')?.points ?? []
  return (['d10', 'd20', 'month'] as const).map((w) => ({
    key: w,
    label: WINDOW_LABEL[w],
    newest: points.find((p) => p.window === w) ?? null,
  }))
})
const krSources = computed(() =>
  korea.value.flatMap((r) =>
    r.newest
      ? [{ source_url: r.newest.source_url, fetched_at: r.newest.first_seen_at, label: r.label }]
      : [],
  ),
)

const hsColumns: TableColumn[] = [
  { key: 'series', label: 'Series' },
  { key: 'month', label: 'Month' },
  { key: 'exports', label: 'Exports', numeric: true, hint: 'US$ billion' },
  { key: 'yoy', label: 'YoY', numeric: true, hint: 'ours, from the values' },
  { key: 'trend', label: 'Since 2013' },
  { key: 'seen', label: 'Released' },
]
const hs8542 = computed(() => {
  const points = props.data.series.find((s) => s.series === 'kr_hs8542_exports')?.points ?? []
  const newest = points[0] ?? null
  const yearAgo = newest
    ? points.find(
        (p) => p.period === `${Number(newest.period.slice(0, 4)) - 1}${newest.period.slice(4)}`,
      )
    : undefined
  return [
    {
      key: 'kr_hs8542_exports',
      newest,
      yoy: newest && yearAgo ? (newest.value / yearAgo.value - 1) * 100 : null,
      spark: points.toReversed().map((p) => p.value),
    },
  ]
})
const hsSources = computed(() =>
  hs8542.value.flatMap((r) =>
    r.newest
      ? [
          {
            source_url: r.newest.source_url,
            fetched_at: r.newest.first_seen_at,
            label: `UN Comtrade, ${r.newest.period}`,
          },
        ]
      : [],
  ),
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
    if (s.series !== 'tw_revenue') continue
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

    <TerminalTable
      caption="Korea’s semiconductor exports, newest release per period"
      :columns="krColumns"
      :rows="korea"
      :row-key="(r) => r.key"
      :gap="(r) => r.newest === null"
      :gap-columns="['month', 'exports', 'yoy', 'seen']"
      nested
      stack
    >
      <template #cell-window="{ row: r }">
        <span class="text-highlighted">{{ r.label }}</span>
      </template>
      <template #cell-month="{ row: r }">{{ r.newest?.period }}</template>
      <template #cell-exports="{ row: r }">
        <span v-if="r.newest">{{ billions(r.newest.value) }}</span>
      </template>
      <template #cell-yoy="{ row: r }">
        {{ r.newest?.yoy_pct == null ? '—' : signedPercent(r.newest.yoy_pct) }}
      </template>
      <template #cell-seen="{ row: r }">
        <span v-if="r.newest" class="text-xs text-muted">
          {{ stamps.absolute(r.newest.published_at ?? r.newest.first_seen_at) }}
        </span>
      </template>
      <template #gap>
        <span class="text-sm text-muted">No release read yet.</span>
      </template>
    </TerminalTable>
    <TerminalSources :sources="krSources">
      <span>Korea Customs Service, under KOGL Type 1 (Korea Open Government License)</span>
    </TerminalSources>

    <TerminalTable
      caption="Korea’s exports of HS 8542 (electronic integrated circuits) to the world, newest month"
      :columns="hsColumns"
      :rows="hs8542"
      :row-key="(r) => r.key"
      :gap="(r) => r.newest === null"
      :gap-columns="['month', 'exports', 'yoy', 'trend', 'seen']"
      nested
      stack
    >
      <template #cell-series>
        <span class="text-highlighted">HS 8542 integrated circuits</span>
      </template>
      <template #cell-month="{ row: r }">{{ r.newest?.period }}</template>
      <template #cell-exports="{ row: r }">
        <span v-if="r.newest">{{ billions(r.newest.value) }}</span>
      </template>
      <template #cell-yoy="{ row: r }">
        {{ r.yoy == null ? '—' : signedPercent(r.yoy) }}
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
    <TerminalSources :sources="hsSources">
      <span>Source: UN Comtrade.</span>
    </TerminalSources>

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
