<script setup lang="ts">
// Status-page incidents per month before our first read of each lab's feed,
// from the Internet Archive's copies of the same feeds. A month the copies
// don't reach whole is a break in the line, not a low count.

import { count } from '#layers/core/shared/utils/terminal-format'
import type { IncidentArchiveView } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '#layers/core/app/types/terminal-ui'

const props = defineProps<{ archived: IncidentArchiveView }>()

const stamps = useStamps()
// Five full YYYY-MM labels collide in a card; the readout keeps the full month.
const tickLabel = (m: string) => m.slice(2)
const monthLabel = (m: string) => m

const charts = computed(() =>
  props.archived.labs
    .map((l) => ({ lab: l, values: l.counts.map((c, i) => (l.covered[i] === 1 ? c : null)) }))
    .filter((c) => c.values.filter((v) => v !== null).length > 1),
)
const yMax = computed(() =>
  Math.max(1, ...charts.value.flatMap((c) => c.values.filter((v): v is number => v !== null))),
)

const columns: TableColumn[] = [
  { key: 'lab', label: 'Lab' },
  { key: 'span', label: 'Copies' },
  { key: 'incidents', label: 'Incidents', numeric: true },
  { key: 'source', label: 'Source', keep: true },
]
const rows = computed(() => [
  ...props.archived.labs.map((l) => ({ ...l, none: false })),
  ...props.archived.not_covered.map((n) => ({
    provider: n.provider,
    display: n.display,
    first_copy: null,
    last_copy: null,
    incidents: 0,
    feeds: [],
    none: true,
  })),
])
</script>

<template>
  <div class="space-y-3">
    <div v-if="charts.length" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <TerminalCard
        v-for="c in charts"
        :id="`incidents-archived-${c.lab.provider}`"
        :key="c.lab.provider"
        :title="c.lab.display"
      >
        <TerminalLineChart
          :x="archived.months"
          :series="[{ id: 'count', label: 'Incidents', values: c.values }]"
          :format="(v) => count(v)"
          :x-label="tickLabel"
          :point-label="monthLabel"
          :y-max="yMax"
          :height="140"
          :title="`Status-page incidents ${c.lab.display} posted per month, from archived copies of its feed`"
        />
      </TerminalCard>
    </div>

    <TerminalTable
      caption="Archived copies of each lab’s status feed"
      :columns="columns"
      :rows="rows"
      :row-key="(r) => r.provider"
      align="top"
      flow
      stack
    >
      <template #cell-lab="{ row: r }">{{ r.display }}</template>
      <template #cell-span="{ row: r }">
        <span v-if="r.first_copy && r.last_copy" class="font-mono"
          >{{ stamps.date(r.first_copy) }} – {{ stamps.date(r.last_copy) }}</span
        >
        <span v-else class="text-muted">none</span>
      </template>
      <template #cell-incidents="{ row: r }">{{ r.none ? '—' : count(r.incidents) }}</template>
      <template #cell-source="{ row: r }">
        <ul v-if="r.feeds.length" class="space-y-1">
          <li v-for="f in r.feeds" :key="f.url">
            <a
              :href="f.archive_url"
              target="_blank"
              rel="noopener noreferrer"
              class="font-mono text-xs break-all underline underline-offset-2"
              >{{ f.url.replace(/^https:\/\//, '') }}</a
            >
          </li>
        </ul>
        <span v-else class="text-muted">—</span>
      </template>
    </TerminalTable>

    <p class="text-xs text-toned">
      Source: copies of each lab’s status feed in the
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
