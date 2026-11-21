<script setup lang="ts">
// GPU rental prices before our first read of each provider's page: the
// weekly median over the Internet Archive's copies, one chart per GPU, then
// how far each provider's copies reach and every copy with its source. The
// method is on /data and in the payload's `method`; the panel only credits
// the Archive, which its terms ask for.

import { count, gpuHour } from '../../../shared/utils/terminal-format'
import { dayLabel } from '../../../shared/utils/thesis-format'
import type { ArchivedGpuPoint, GpuArchiveView } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ archived: GpuArchiveView }>()

const stamps = useStamps()
const monthLabel = (x: string) => x.slice(0, 7)
const drawable = (values: (number | null)[]) => values.filter((v) => v !== null).length > 1
const first = computed(() => props.archived.dates[0] ?? '')
const last = computed(() => props.archived.dates.at(-1) ?? '')

const charts = computed(() =>
  props.archived.gpus
    .filter((g) => drawable(g.median))
    .map((g) => {
      const counted = g.providers.filter((n) => n > 0)
      return {
        gpu: g.gpu,
        series: [{ id: 'median', label: 'Median', values: g.median }],
        providers: counted.length ? `${Math.min(...counted)} to ${Math.max(...counted)}` : '0',
      }
    }),
)

const reachColumns: TableColumn[] = [
  { key: 'provider', label: 'Provider' },
  { key: 'span', label: 'Copies from' },
  { key: 'read', label: 'Copies', numeric: true },
  { key: 'h100', label: 'H100, first → last' },
  { key: 'gaps', label: 'Gaps', class: 'text-muted' },
]
const ends = (points: ArchivedGpuPoint[], key: 'h100' | 'b200') => {
  const values = points.map((p) => p[key]).filter((v): v is number => v !== null)
  return values.length ? `${gpuHour(values[0]!)} → ${gpuHour(values.at(-1)!)}` : '—'
}
const reachRows = computed(() =>
  props.archived.providers.map((p) => ({
    ...p,
    gaps: props.archived.gaps.filter((g) => g.provider === p.provider),
  })),
)

const copyColumns: TableColumn[] = [
  { key: 'at', label: 'Copy of', class: 'font-mono whitespace-nowrap' },
  { key: 'provider_name', label: 'Provider' },
  { key: 'h100', label: 'H100 $/GPU-hr', numeric: true },
  { key: 'b200', label: 'B200 $/GPU-hr', numeric: true },
  { key: 'source', label: 'Source', keep: true },
]
const copies = computed(() =>
  props.archived.providers
    .flatMap((p) => p.points.map((pt) => ({ ...pt, provider_name: p.provider_name })))
    .sort((a, b) => (a.at < b.at ? 1 : -1)),
)
</script>

<template>
  <div class="space-y-3">
    <div v-if="charts.length" class="grid gap-3 lg:grid-cols-2">
      <TerminalCard v-for="c in charts" :id="`gpu-archived-${c.gpu}`" :key="c.gpu" :title="c.gpu">
        <template #meta>
          <span>Median of {{ c.providers }} providers a week</span>
        </template>
        <TerminalLineChart
          :x="archived.dates"
          :series="c.series"
          :format="gpuHour"
          :x-label="monthLabel"
          step
          :title="`Weekly median on-demand ${c.gpu} price per GPU-hour, ${dayLabel(first)} to ${dayLabel(last)}`"
        />
      </TerminalCard>
    </div>

    <TerminalTable
      caption="How far back each provider’s archived GPU prices reach"
      :columns="reachColumns"
      :rows="reachRows"
      :row-key="(r) => r.provider"
      align="top"
      flow
      stack
    >
      <template #cell-provider="{ row: r }">{{ r.provider_name }}</template>
      <template #cell-span="{ row: r }">
        <span v-if="r.points.length" class="font-mono"
          >{{ stamps.date(r.points[0]!.at) }} – {{ stamps.date(r.points.at(-1)!.at) }}</span
        >
        <span v-else class="text-muted">none read</span>
      </template>
      <template #cell-read="{ row: r }">{{ count(r.points.length) }}</template>
      <template #cell-h100="{ row: r }">{{ ends(r.points, 'h100') }}</template>
      <template #cell-gaps="{ row: r }">
        <ul v-if="r.gaps.length" class="space-y-1">
          <li v-for="g in r.gaps" :key="g.from" class="font-mono">
            {{ stamps.date(g.from) }} – {{ stamps.date(g.until) }}
          </li>
        </ul>
        <span v-else>—</span>
      </template>
    </TerminalTable>

    <TerminalExpand show="Every copy, as a table" hide="Hide the copies">
      <TerminalTable
        caption="Each archived copy of a provider’s price page, newest first"
        :columns="copyColumns"
        :rows="copies"
        :row-key="(a) => `${a.source_id}:${a.at}`"
        nested
      >
        <template #cell-at="{ row: a }">{{ stamps.date(a.at) }}</template>
        <template #cell-h100="{ row: a }">{{ a.h100 === null ? '—' : gpuHour(a.h100) }}</template>
        <template #cell-b200="{ row: a }">{{ a.b200 === null ? '—' : gpuHour(a.b200) }}</template>
        <template #cell-source="{ row: a }">
          <TerminalProvenanceTag
            :source-url="a.source_url"
            :fetched-at="a.fetched_at"
            label="Internet Archive"
          />
        </template>
      </TerminalTable>
    </TerminalExpand>

    <p class="text-xs text-toned">
      Source: copies of each provider’s price page in the
      <a
        href="https://web.archive.org/"
        target="_blank"
        rel="noopener noreferrer"
        class="py-1.5 underline underline-offset-2 hover:text-default"
        >Internet Archive</a
      >.
    </p>
  </div>
</template>
