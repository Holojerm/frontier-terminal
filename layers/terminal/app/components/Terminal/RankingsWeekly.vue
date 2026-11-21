<script setup lang="ts">
// The long run: each lab's weekly share of OpenRouter tokens over the whole
// stored history, one small chart per lab. Nine labs are too many lines for
// one chart with one accent (DESIGN.md allows three series), so each lab gets
// its own line on a y-axis shared across the grid, which keeps their heights
// comparable. The table carries every week and `other`, so the charts never
// gate a number.

import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import { sharePct } from '../../../shared/utils/terminal-format'
import type { ProviderId, RankingsData } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ rankings: RankingsData }>()

const stamps = useStamps()

const LABS = (Object.keys(LAB_DISPLAY) as ProviderId[]).filter((p) => p !== 'other')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const weeks = computed(() => props.rankings.weekly)
const x = computed(() => weeks.value.map((w) => w.week))
const first = computed(() => weeks.value[0] ?? null)
const last = computed(() => weeks.value.at(-1) ?? null)

const monthLabel = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ’${d.slice(2, 4)}`
const weekLabel = (d: string) => `Week of ${stamps.date(d)}`
const wholePct = (v: number) => `${Math.round(v * 100)}%`

const yMax = computed(() =>
  Math.max(0, ...weeks.value.flatMap((w) => LABS.map((p) => w.share[p] ?? 0))),
)

const charts = computed(() =>
  LABS.map((p) => ({
    id: p,
    label: LAB_DISPLAY[p],
    newest: last.value?.share[p] ?? null,
    series: [{ id: p, label: LAB_DISPLAY[p], values: weeks.value.map((w) => w.share[p]) }],
  })),
)

const columns: TableColumn[] = [
  { key: 'week', label: 'Week of', class: 'font-mono' },
  { key: 'days', label: 'Days', numeric: true },
  ...(Object.keys(LAB_DISPLAY) as ProviderId[]).map((p) => ({
    key: p,
    label: LAB_DISPLAY[p],
    numeric: true,
  })),
]
const rows = computed(() =>
  [...weeks.value].reverse().map((w) => ({
    week: w.week,
    days: String(w.days),
    ...Object.fromEntries(
      (Object.keys(LAB_DISPLAY) as ProviderId[]).map((p) => [p, sharePct(w.share[p])]),
    ),
  })),
)
</script>

<template>
  <div class="space-y-4">
    <TerminalGap
      v-if="weeks.length < 2"
      title="One week on record so far."
      reason="A line needs two. The table has the first week."
    />
    <template v-else>
      <p class="text-xs text-muted">
        Week of {{ stamps.date(first!.week) }} to week of {{ stamps.date(last!.week) }}.
        <template v-if="last!.days < 7">
          The newest week has {{ last!.days }} day{{ last!.days === 1 ? '' : 's' }} so far.
        </template>
      </p>
      <div class="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        <section v-for="c in charts" :id="`weekly-${c.id}`" :key="c.id" class="space-y-1">
          <h3 class="flex items-baseline justify-between gap-2 text-sm">
            <span class="text-default">{{ c.label }}</span>
            <span class="font-mono text-highlighted">{{ sharePct(c.newest) }}</span>
          </h3>
          <TerminalLineChart
            :x="x"
            :series="c.series"
            :format="sharePct"
            :tick-format="wholePct"
            :y-max="yMax"
            :height="140"
            :x-label="monthLabel"
            :point-label="weekLabel"
            :title="`${c.label}’s weekly share of OpenRouter tokens, week of ${stamps.date(first!.week)} to week of ${stamps.date(last!.week)}`"
          />
        </section>
      </div>
    </template>

    <TerminalExpand show="Every week, as a table" hide="Hide the weekly table">
      <TerminalTable
        caption="Each lab’s share of OpenRouter tokens per week, newest first"
        :columns="columns"
        :rows="rows"
        :row-key="(r) => r.week"
        nested
      />
    </TerminalExpand>

    <TerminalSources
      :sources="
        rankings.provenance ? [{ label: rankings.source.label, ...rankings.provenance }] : []
      "
      :caveats="[
        {
          label: 'OpenRouter share, not market share',
          text:
            rankings.source.caveat ??
            'One aggregator’s traffic. Treat it as a rough read on demand.',
        },
      ]"
    >
      <span v-if="rankings.meta.citation">{{ rankings.meta.citation }}</span>
    </TerminalSources>
  </div>
</template>
