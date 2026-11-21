<script setup lang="ts">
// Each coding agent's public pull requests per ISO week, back to its launch.
// One chart per agent on its own y-axis: each agent leaves a different trace,
// so a shared axis would invite reading them as shares. The weeks walked back
// after we began were counted later, from the PRs that still existed, so they
// draw as their own named series (sources.yaml › github-prs-*). The daily series starts
// at the last week counted later, so the line doesn't break at the handover,
// and the later series' end dot marks where it happens.

import { newestFullWeek, weekColumns, weekValues } from '../../../shared/utils/adoption-weeks'
import { compactCount, count } from '../../../shared/utils/terminal-format'
import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import type { AdoptionData } from '../../../shared/utils/recipe-views'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ agents: AdoptionData['agent_prs']; caveat: string }>()

const stamps = useStamps()

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ’${d.slice(2, 4)}`
const weekLabel = (d: string) => `Week of ${stamps.date(d)}`

const shown = computed(() => props.agents.filter((a) => a.weekly.length > 0))

const charts = computed(() =>
  shown.value.map((a) => {
    const x = weekColumns(a.weekly[0]!.week, a.weekly.at(-1)!.week)
    const firstDaily = a.weekly.find((w) => !w.retrospective)?.week ?? null
    const handover = firstDaily
      ? a.weekly.filter((w) => w.retrospective && w.week < firstDaily).at(-1)?.week
      : undefined
    const live = weekValues(a.weekly, x, (w) => !w.retrospective || w.week === handover)
    const later = weekValues(a.weekly, x, (w) => w.retrospective)
    const anyLater = a.weekly.some((w) => w.retrospective)
    return {
      ...a,
      x,
      newest: newestFullWeek(a.weekly),
      // Daily always takes the first slot, so "counted later" keeps one ink on
      // every chart, including one with no daily week yet.
      series: [
        { id: `${a.recipe_id}-daily`, label: 'Counted daily', values: live },
        ...(anyLater
          ? [{ id: `${a.recipe_id}-later`, label: 'Counted later', values: later }]
          : []),
      ],
    }
  }),
)

const columns = computed<TableColumn[]>(() => [
  { key: 'week', label: 'Week of', class: 'font-mono whitespace-nowrap' },
  ...shown.value.map((a) => ({
    key: a.recipe_id,
    label: a.agent,
    hint: LAB_DISPLAY[a.lab],
    numeric: true,
  })),
])

function cell(w: AdoptionData['agent_prs'][number]['weekly'][number] | undefined): string {
  if (!w) return '—'
  const notes = [
    ...(w.partial ? [`${w.days} of 7 days`] : []),
    ...(w.retrospective ? ['counted later'] : []),
  ]
  return notes.length ? `${count(w.total)} (${notes.join(', ')})` : count(w.total)
}

const rows = computed(() => {
  const at = new Map(
    shown.value.map((a) => [a.recipe_id, new Map(a.weekly.map((w) => [w.week, w]))]),
  )
  const weeks = [...new Set(shown.value.flatMap((a) => a.weekly.map((w) => w.week)))].sort()
  return weeks.reverse().map((week) => ({
    week,
    ...Object.fromEntries(
      shown.value.map((a) => [a.recipe_id, cell(at.get(a.recipe_id)!.get(week))]),
    ),
  }))
})
</script>

<template>
  <div class="space-y-4">
    <TerminalGap
      v-if="shown.length === 0"
      title="No complete week counted yet."
      reason="We count them once a day with GitHub’s search API."
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
              <span class="text-default">{{ c.agent }}</span>
              <span class="text-toned"> · {{ LAB_DISPLAY[c.lab] }}</span>
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
            :title="`Public GitHub pull requests from ${c.agent} per week, week of ${stamps.date(c.x[0]!)} to week of ${stamps.date(c.x.at(-1)!)}`"
          />
          <TerminalGap v-else inline title="One week counted so far." />
          <p class="text-xs text-muted">Search: <code>{{ c.query }}</code></p>
          <TerminalProvenanceTag
            v-if="c.source"
            :source-url="c.source.source_url"
            :fetched-at="c.source.fetched_at"
            label="GitHub search"
            class="text-xs"
          />
        </section>
      </div>
      <p class="text-xs text-muted">
        Weeks run Monday to Sunday, UTC. Weeks counted later miss PRs deleted or made private since.
      </p>
    </template>

    <TerminalExpand v-if="shown.length" show="Every week, as a table" hide="Hide the weekly table">
      <TerminalTable
        caption="Public GitHub pull requests per week from each lab’s coding agent, newest first"
        :columns="columns"
        :rows="rows"
        :row-key="(r) => r.week"
        nested
      />
    </TerminalExpand>

    <TerminalSources
      :sources="shown.flatMap((a) => (a.source ? [a.source] : [])).slice(0, 1)"
      :caveats="[{ text: caveat, label: 'one trend per agent' }]"
    />
  </div>
</template>
