<script setup lang="ts">
// The hiring axis over time: open roles per lab per day, reconstructed by
// undoing the change log backwards from each board's current listing, and
// the department mix now against the comparison instant. Google is a stated
// cut and xAI's board carries its entity-blend caveat, both stated in the
// by-lab table the overview leads with.

import { absoluteStamp, count, signed } from '../../shared/utils/terminal-format'
import { dayLabel } from '../../shared/utils/thesis-format'
import type { HiringHistoryData, HiringHistoryProvider } from '../../shared/utils/terminal-types'
import type { DataCentersData, PayData } from '../../shared/utils/recipe-views'
import type { TableColumn } from '../types/terminal-ui'

const NO_DEPARTMENT = '(no department)'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Hiring',
    summary:
      'Open roles per day at OpenAI, Anthropic, and xAI, reconstructed from each job board’s change log; the physical-infrastructure buildout cluster per lab; the department mix now against 30 days ago; and per-board caveats.',
  },
})

const [{ data: hiring, error }, { data: pay }, { data: power }] = await Promise.all([
  useFetch<HiringHistoryData>('/api/hiring/history'),
  useFetch<PayData>('/api/pay'),
  useFetch<DataCentersData>('/api/datacenters'),
])

useSeo({
  title: 'AI lab hiring: open roles over time',
  description:
    'Open roles over time at the frontier AI labs, per day and per department, reconstructed from each job board’s change log with the source URL behind every count.',
  dateModified: hiring.value?.as_of,
})

const now = useNow()

const boards = computed(() =>
  (hiring.value?.providers ?? []).filter((p) => p.feed === 'ok' && p.dates.length > 0),
)

// One x axis across the boards: the union of their dates, with null where
// a board's series has not started.
const chart = computed(() => {
  const dates = [...new Set(boards.value.flatMap((p) => p.dates))].sort()
  return {
    x: dates,
    series: boards.value.map((p) => {
      const at = new Map(p.dates.map((d, i) => [d, p.total[i]!]))
      return { id: p.provider, label: p.display, values: dates.map((d) => at.get(d) ?? null) }
    }),
  }
})

const anyLog = computed(() => (hiring.value?.log.changes ?? 0) > 0)

// Rows that held still say nothing; hide them unless asked.
const movedOnly = ref(true)
const compareRows = (p: HiringHistoryProvider) =>
  (p.compare?.departments ?? []).filter((d) => !movedOnly.value || d.now !== d.then)
const unchanged = (p: HiringHistoryProvider) =>
  (p.compare?.departments ?? []).filter((d) => d.now === d.then).length

const dailyColumns = computed<TableColumn[]>(() => [
  { key: 'date', label: 'Date', class: 'font-mono' },
  ...chart.value.series.map((x) => ({ key: x.id, label: x.label, numeric: true })),
])
const dailyRows = computed(() =>
  chart.value.x.map((date, i) => ({
    date,
    ...Object.fromEntries(
      chart.value.series.map((x) => [x.id, x.values[i] === null ? '—' : count(x.values[i]!)]),
    ),
  })),
)

const deptColumns = (p: HiringHistoryProvider): TableColumn[] => [
  { key: 'department', label: 'Department', class: 'max-w-48 truncate text-default' },
  { key: 'then', label: p.compare?.at ?? 'Then', numeric: true, class: 'text-muted' },
  { key: 'now', label: 'Now', numeric: true },
  { key: 'delta', label: 'Δ', numeric: true, class: 'text-highlighted' },
]
</script>

<template>
  <TerminalPage
    title="Hiring"
    lede="Open roles per day, per lab, reconstructed from each board’s change log. Nothing is estimated."
    :as-of="hiring?.as_of"
    :error="Boolean(error)"
    error-title="Hiring history could not be read"
    error-body="The history endpoint failed to respond. No stale or inferred number is shown in its place."
  >
    <template v-if="hiring">
      <TerminalPanel
        id="labs"
        title="By lab"
        note="Open roles per board, the infrastructure cluster, and the department that moved most."
        flush
      >
        <TerminalHiringSummary :history="hiring" />
      </TerminalPanel>

      <TerminalPanel
        id="series"
        title="Open roles over time"
        :note="
          anyLog
            ? `${count(hiring.log.changes)} job change rows from ${hiring.log.from?.slice(0, 10)} to ${hiring.log.to?.slice(0, 10)}, applied backwards from each board’s current listing.`
            : 'No job change rows yet; each board shows its current listing only.'
        "
      >
        <TerminalLineChart
          v-if="chart.series.length && chart.x.length > 1"
          :x="chart.x"
          :series="chart.series"
          :format="count"
          :x-label="dayLabel"
          :title="`Open roles per day at ${chart.series.map((s) => s.label).join(', ')} from ${chart.x[0]} to ${chart.x.at(-1)}`"
        />
        <TerminalGap
          v-else
          title="No series to draw yet."
          reason="A series needs a board with a current listing and at least two days on record. Each board’s first poll sets its baseline."
          :action="{ label: 'See coverage', to: '/data#coverage' }"
        />

        <TerminalExpand
          v-if="chart.x.length > 1"
          show="Show the daily table"
          hide="Hide the daily table"
        >
          <TerminalTable
            caption="Open roles at the end of each day, per lab"
            :columns="dailyColumns"
            :rows="dailyRows"
            :row-key="(r) => r.date"
            nested
          />
        </TerminalExpand>
      </TerminalPanel>

      <TerminalPanel
        id="buildout"
        title="Physical-infrastructure buildout"
        note="Data-center, facilities, energy, construction, compute and hardware roles per lab per day."
      >
        <TerminalBuildoutPanel :history="hiring" />
      </TerminalPanel>

      <TerminalPanel
        v-if="power?.snapshot"
        id="power"
        title="Data-center power"
        note="Epoch AI’s estimate of the power each lab’s data centers draw: what the buildout roles are building."
        :more="{ label: 'Every site, and GPU rental prices', to: '/compute' }"
      >
        <TerminalDataCenterPower :data="power" />
      </TerminalPanel>

      <TerminalPanel
        id="departments"
        title="Department mix, now against earlier"
        :note="`Open roles by department, now against ${hiring.window_days} days ago or the first day on record.`"
      >
        <UCheckbox v-model="movedOnly" label="Only departments that moved" />
        <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <TerminalCard
            v-for="p in hiring.providers"
            :id="p.provider"
            :key="p.provider"
            :title="p.display"
            :sources="p.sources"
          >
            <template #meta>
              <TerminalCaveatMark v-if="p.caveat" label="blended board" :text="p.caveat" />
              <span v-if="p.compare">
                <span class="font-mono text-highlighted">{{ count(p.compare.total_now) }}</span>
                open,
                <span class="font-mono">{{
                  signed(p.compare.total_now - p.compare.total_then)
                }}</span>
                since {{ p.compare.at }}
              </span>
            </template>

            <TerminalGap v-if="feedGap('hiring', p)" inline v-bind="feedGap('hiring', p)!" />

            <template v-else-if="p.compare">
              <p v-if="compareRows(p).length === 0" class="text-xs text-muted">
                No department moved; {{ unchanged(p) }} unchanged.
              </p>
              <TerminalTable
                v-else
                :caption="`${p.display} open roles by department, then and now`"
                :columns="deptColumns(p)"
                :rows="
                  compareRows(p).map((d) => ({
                    ...d,
                    delta: d.now === d.then ? '±0' : signed(d.now - d.then),
                  }))
                "
                :row-key="(d) => d.department"
                nested
              >
                <template #cell-department="{ row: d }">
                  <span :title="d.department">{{ d.department }}</span>
                </template>
              </TerminalTable>
              <p
                v-if="movedOnly && compareRows(p).length && unchanged(p)"
                class="text-xs text-muted"
              >
                {{ unchanged(p) }} unchanged hidden.
              </p>
              <p
                v-if="p.join_from && p.compare.at < p.join_from.slice(0, 10)"
                class="text-xs text-muted"
              >
                Departments joined from {{ absoluteStamp(p.join_from, now) }}; earlier rows read “{{
                  NO_DEPARTMENT
                }}”.
              </p>
              <p
                v-if="p.baseline_at && p.series_from && p.baseline_at > p.series_from"
                class="text-xs text-muted"
              >
                Rows before the {{ absoluteStamp(p.baseline_at, now) }} baseline are imported
                history, carried as they stand today.
              </p>
            </template>
          </TerminalCard>
        </div>
      </TerminalPanel>

      <TerminalPanel
        v-if="pay?.boards.length"
        id="pay"
        title="Posted pay"
        note="The median midpoint of the US salary bands each board posts, for all roles, research and software engineering."
      >
        <TerminalPayTable :pay="pay" />
      </TerminalPanel>
    </template>
  </TerminalPage>
</template>
