<script setup lang="ts">
// The long run of each package's downloads: complete ISO weeks over every
// stored day, one small chart per package. The levels aren't comparable
// across packages (DownloadsTable says why), so each chart has its own
// y-axis. A partial week breaks the line instead of reading as a drop, and
// the table has its total and how many days it rests on. Each registry's
// history starts where its API's reach did, and the line under the charts
// gives that week, so a short line isn't read as a young package.

import { newestFullWeek, weekColumns, weekValues } from '../../../shared/utils/adoption-weeks'
import { compactCount, count } from '../../../shared/utils/terminal-format'
import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import type { AdoptionData } from '../../../shared/utils/recipe-views'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{
  downloads: AdoptionData['downloads']
  caveat: string
  /** 'sdk' or 'agent' to show one kind. */
  kind?: 'sdk' | 'agent'
}>()

const stamps = useStamps()

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ’${d.slice(2, 4)}`
const weekLabel = (d: string) => `Week of ${stamps.date(d)}`

const packages = computed(() =>
  props.downloads
    .filter((d) => (!props.kind || d.kind === props.kind) && d.weekly.length > 0)
    .map((d) => ({ ...d, newest: newestFullWeek(d.weekly) }))
    .sort((a, b) => (b.newest?.total ?? -1) - (a.newest?.total ?? -1)),
)

const charts = computed(() =>
  packages.value.map((p) => {
    const x = weekColumns(p.weekly[0]!.week, p.weekly.at(-1)!.week)
    return {
      ...p,
      x,
      series: [{ id: p.recipe_id, label: p.package, values: weekValues(p.weekly, x) }],
    }
  }),
)

/** Where each registry's lines start, for the registries shown. */
const starts = computed(() => {
  const first = (r: 'npm' | 'PyPI') =>
    packages.value
      .filter((p) => p.registry === r)
      .map((p) => p.weekly[0]!.week)
      .sort()[0] ?? null
  return { npm: first('npm'), pypi: first('PyPI') }
})

const columns = computed<TableColumn[]>(() => [
  { key: 'week', label: 'Week of', class: 'font-mono whitespace-nowrap' },
  ...packages.value.map((p) => ({
    key: p.recipe_id,
    label: p.package,
    hint: p.registry,
    numeric: true,
  })),
])

const cell = (w: { total: number; days: number; partial: boolean } | undefined) =>
  !w ? '—' : w.partial ? `${count(w.total)} (${w.days} of 7 days)` : count(w.total)

const rows = computed(() => {
  const at = new Map(
    packages.value.map((p) => [p.recipe_id, new Map(p.weekly.map((w) => [w.week, w]))]),
  )
  const weeks = [...new Set(packages.value.flatMap((p) => p.weekly.map((w) => w.week)))].sort()
  return weeks.reverse().map((week) => ({
    week,
    ...Object.fromEntries(
      packages.value.map((p) => [p.recipe_id, cell(at.get(p.recipe_id)!.get(week))]),
    ),
  }))
})

const sources = computed(() =>
  packages.value.flatMap((p) => (p.source ? [p.source] : [])).slice(0, 2),
)
</script>

<template>
  <div class="space-y-4">
    <TerminalGap
      v-if="packages.length === 0"
      title="No complete week on record yet."
      reason="A week shows once its Sunday is in the registry’s data."
    />
    <template v-else>
      <div class="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        <section
          v-for="c in charts"
          :id="`weekly-${c.recipe_id}`"
          :key="c.recipe_id"
          class="min-w-0 space-y-1"
        >
          <h3 class="flex items-baseline justify-between gap-2 text-sm">
            <span class="min-w-0 truncate">
              <a
                v-if="c.source"
                :href="c.source.source_url"
                class="font-mono text-default"
                target="_blank"
                rel="noopener noreferrer"
                >{{ c.package }}</a
              >
              <span v-else class="font-mono text-default">{{ c.package }}</span>
              <span class="text-toned"> · {{ c.registry }} · {{ LAB_DISPLAY[c.lab] }}</span>
            </span>
            <span class="shrink-0 font-mono text-highlighted">{{
              c.newest ? compactCount(c.newest.total) : '—'
            }}</span>
          </h3>
          <TerminalLineChart
            v-if="c.x.length > 1"
            :x="c.x"
            :series="c.series"
            :format="count"
            :tick-format="compactCount"
            :height="140"
            :x-label="monthLabel"
            :point-label="weekLabel"
            :title="`${c.package} downloads on ${c.registry} per week, week of ${stamps.date(c.x[0]!)} to week of ${stamps.date(c.x.at(-1)!)}`"
          />
          <TerminalGap v-else inline title="One week on record so far." />
          <TerminalProvenanceTag
            v-if="c.source"
            :source-url="c.source.source_url"
            :fetched-at="c.source.fetched_at"
            :label="`${c.registry} downloads`"
            class="text-xs"
          />
        </section>
      </div>
      <p class="text-xs text-muted">
        Weeks run Monday to Sunday, UTC.
        <template v-if="starts.npm"
          >npm history starts the week of {{ stamps.date(starts.npm) }}.</template
        >
        <template v-if="starts.pypi">
          PyPI history starts the week of {{ stamps.date(starts.pypi) }}.</template
        >
      </p>
    </template>

    <TerminalExpand
      v-if="packages.length"
      show="Every week, as a table"
      hide="Hide the weekly table"
    >
      <TerminalTable
        :caption="
          kind === 'agent'
            ? 'Coding-agent package downloads per week, newest first'
            : 'SDK downloads per week, newest first'
        "
        :columns="columns"
        :rows="rows"
        :row-key="(r) => r.week"
        nested
      />
    </TerminalExpand>

    <TerminalSources
      :sources="sources"
      :caveats="[{ text: caveat, label: 'downloads, not users' }]"
    />
  </div>
</template>
