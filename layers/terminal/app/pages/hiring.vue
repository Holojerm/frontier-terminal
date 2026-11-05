<script setup lang="ts">
// The hiring axis over time: open roles per lab per day, reconstructed by
// undoing the change log backwards from each board's current listing, and
// the department mix now against the comparison instant. Google is a stated
// cut and xAI's board carries its entity-blend caveat, both stated in the
// by-lab table the overview leads with.

import { HISTORY_LICENSE } from '#shared/utils/license'
import { absoluteStamp, count, signed } from '../../shared/utils/terminal-format'
import { dayLabel } from '../../shared/utils/thesis-format'
import type {
  ArchivedHiringPoint,
  HiringHistoryData,
  HiringHistoryProvider,
} from '../../shared/utils/terminal-types'
import type { DataCentersData, PayData } from '../../shared/utils/recipe-views'
import type { TableColumn } from '../types/terminal-ui'

const NO_DEPARTMENT = '(no department)'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Hiring',
    summary:
      'Open roles per day at OpenAI, Anthropic, and xAI, rebuilt from each job board’s change log. Also infrastructure hiring per lab, the department mix now against 30 days ago, each board’s caveats, and open roles back to 2023 from the Internet Archive’s copies of each board.',
  },
})

const [{ data: hiring, error }, { data: pay }, { data: power }] = await Promise.all([
  // The archived copies' departments stay in the API and the export; this
  // page draws only their totals and infrastructure counts.
  useFetch<HiringHistoryData>('/api/hiring/history', { transform: slimArchive }),
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

// Before we read the boards: one card per lab with archived copies.
const archivedBoards = computed(() =>
  (hiring.value?.providers ?? []).filter((p) => p.archived.length > 0),
)
const infraOf = (a: ArchivedHiringPoint) => a.clusters?.[0]?.open_roles ?? null
const monthLabel = (x: string) => x.slice(0, 7)
const archivedSeries = (p: HiringHistoryProvider) => {
  const infra = p.archived.map(infraOf)
  return [
    { id: 'total', label: 'Open roles', values: p.archived.map((a) => a.total) },
    ...(infra.some((v) => v !== null)
      ? [{ id: 'infra', label: 'Infrastructure', values: infra }]
      : []),
  ]
}
const archivedColumns: TableColumn[] = [
  { key: 'at', label: 'Copy of', class: 'font-mono whitespace-nowrap' },
  { key: 'total', label: 'Open roles', numeric: true },
  { key: 'infra', label: 'Infra', numeric: true },
  { key: 'source', label: 'Source', keep: true },
]

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

// Labs with no public board: one line in the department tab, not a card each.
const fed = computed(() => (hiring.value?.providers ?? []).filter((p) => !feedGap('hiring', p)))
const unfed = computed(() => (hiring.value?.providers ?? []).filter((p) => feedGap('hiring', p)))

// Four questions, one tab each: how many roles, what is being built, which
// teams moved, and what the roles pay.
const tabs = computed(() => [
  { value: 'openings', label: 'Openings' },
  { value: 'infrastructure', label: 'Infrastructure' },
  { value: 'departments', label: 'Departments' },
  ...(pay.value?.boards.length ? [{ value: 'pay', label: 'Pay' }] : []),
])

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
    lede="Open roles per day for each lab, rebuilt from the changes we’ve recorded on each job board. We don’t estimate anything."
    :as-of="hiring?.as_of"
    :error="Boolean(error)"
    error-title="Hiring history didn’t load"
    error-body="We won’t show an old number in its place. Try reloading in a minute."
  >
    <TerminalTabs v-if="hiring" :tabs="tabs">
      <template #openings>
        <TerminalPanel
          id="labs"
          title="By lab"
          note="Open roles per board, infrastructure roles, and the department that changed most."
          flush
        >
          <TerminalHiringSummary :history="hiring" />
        </TerminalPanel>

        <TerminalPanel
          id="series"
          title="Open roles over time"
          :note="
            anyLog
              ? `${count(hiring.log.changes)} recorded job changes from ${hiring.log.from?.slice(0, 10)} to ${hiring.log.to?.slice(0, 10)}, worked backwards from each board’s current listing.`
              : 'No job changes recorded yet. Each board shows only its current listing.'
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
            reason="A line needs a board with a current listing and at least two days of data. Our first check of each board sets its starting point."
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
          v-if="archivedBoards.length || hiring.reach.length"
          id="archived"
          title="Before we read the boards"
          note="Open roles on the Internet Archive’s copies of each lab’s own job board, one a week, until we began reading it ourselves."
        >
          <div class="grid gap-3 lg:grid-cols-2">
            <TerminalCard
              v-for="p in archivedBoards"
              :id="`archived-${p.provider}`"
              :key="p.provider"
              :title="p.display"
            >
              <template #meta>
                <TerminalCaveatMark
                  v-if="p.archive_caveat"
                  label="about these copies"
                  :text="p.archive_caveat"
                />
                <span>
                  {{ count(p.archived.length) }} copies,
                  <span class="font-mono">{{ p.archived[0]!.at.slice(0, 10) }}</span> to
                  <span class="font-mono">{{ p.archived.at(-1)!.at.slice(0, 10) }}</span>
                </span>
              </template>
              <TerminalLineChart
                v-if="p.archived.length > 1"
                :x="p.archived.map((a) => a.at)"
                :series="archivedSeries(p)"
                :format="count"
                :x-label="monthLabel"
                :title="`Open roles on the Internet Archive’s copies of the ${p.display} job board, ${p.archived[0]!.at.slice(0, 10)} to ${p.archived.at(-1)!.at.slice(0, 10)}`"
              />
              <TerminalExpand show="Show the copies" hide="Hide the copies">
                <TerminalTable
                  :caption="`Open roles on each Internet Archive copy of the ${p.display} job board`"
                  :columns="archivedColumns"
                  :rows="p.archived"
                  :row-key="(a) => `${a.source_id}:${a.at}`"
                  nested
                >
                  <template #cell-at="{ row: a }">{{ a.at.slice(0, 10) }}</template>
                  <template #cell-total="{ row: a }">{{ count(a.total) }}</template>
                  <template #cell-infra="{ row: a }">
                    <span v-if="infraOf(a) !== null">{{ count(infraOf(a)!) }}</span>
                    <span v-else class="text-muted" title="This copy lists only the board’s total"
                      >—</span
                    >
                  </template>
                  <template #cell-source="{ row: a }">
                    <TerminalProvenanceTag
                      :source-url="a.source_url"
                      :fetched-at="a.fetched_at"
                      label="Internet Archive"
                    />
                  </template>
                </TerminalTable>
              </TerminalExpand>
            </TerminalCard>
          </div>
          <TerminalArchiveReach
            v-if="hiring.reach.length"
            :reach="hiring.reach"
            caption="How far back each lab’s hiring history reaches"
          />
          <template #foot>
            Each copy is the board as the Archive saw it on that day. We read the copies back in
            2026, so this site didn’t hold these numbers at the time. A copy that lists every role
            gives departments. A copy that pages its list gives only the board’s own total, with no
            Infra count. We skip a copy we can’t read with confidence. Every copy, with its
            departments, is in the
            <span class="font-mono">archived_hiring</span> table on /data, under
            {{ HISTORY_LICENSE.short }}.
          </template>
        </TerminalPanel>
      </template>

      <template #infrastructure>
        <TerminalPanel
          id="buildout"
          title="Physical-infrastructure buildout"
          note="Data-center, facilities, energy, construction, compute, and hardware roles per lab per day."
        >
          <TerminalBuildoutPanel :history="hiring" />
        </TerminalPanel>

        <TerminalPanel
          v-if="power?.snapshot"
          id="power"
          title="Data-center power"
          note="Epoch AI’s estimate of the power each lab’s data centers draw. That’s what the buildout roles are building."
          :more="{ label: 'Every site, and GPU rental prices', to: '/compute' }"
        >
          <TerminalDataCenterPower :data="power" />
        </TerminalPanel>
      </template>

      <template #departments>
        <TerminalPanel
          id="departments"
          title="Department mix, now against earlier"
          :note="`Open roles by department, now against ${hiring.window_days} days ago or the first day on record.`"
        >
          <UCheckbox v-model="movedOnly" label="Only departments that moved" />
          <div class="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            <TerminalCard
              v-for="p in fed"
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

              <template v-if="p.compare">
                <p v-if="compareRows(p).length === 0" class="text-xs text-muted">
                  No department changed. {{ unchanged(p) }} unchanged.
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
                  We have departments from {{ absoluteStamp(p.join_from, now) }} on. Earlier rows
                  show “{{ NO_DEPARTMENT }}”.
                </p>
                <p
                  v-if="p.baseline_at && p.series_from && p.baseline_at > p.series_from"
                  class="text-xs text-muted"
                >
                  Rows before our first check on {{ absoluteStamp(p.baseline_at, now) }} are
                  imported history, shown as they stand today.
                </p>
              </template>
            </TerminalCard>
          </div>
          <p v-if="unfed.length" class="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <span v-for="p in unfed" :id="p.provider" :key="p.provider">
              <span class="mr-1 text-default">{{ p.display }}</span>
              <TerminalGap inline v-bind="feedGap('hiring', p)!" />
            </span>
          </p>
        </TerminalPanel>
      </template>

      <template #pay>
        <TerminalPanel
          v-if="pay?.boards.length"
          id="pay"
          title="Posted pay"
          note="The median midpoint of the US salary bands each board posts, for all roles, for research, and for software engineering."
        >
          <TerminalPayTable :pay="pay" />
        </TerminalPanel>
      </template>
    </TerminalTabs>
  </TerminalPage>
</template>
