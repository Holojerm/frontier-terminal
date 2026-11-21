<script setup lang="ts">
// The long run of each package's downloads: complete ISO weeks over every
// stored day, one small chart per package. The levels aren't comparable
// across packages (DownloadsTable says why), so each chart has its own
// y-axis. A partial week breaks the line instead of reading as a drop, and
// the table has its total and how many days it rests on. Each registry's
// history starts where its API's reach did, and the line under the charts
// gives that week, so a short line isn't read as a young package.
//
// `measure` picks the series: raw weekly totals, npm downloads divided by
// the control basket (normalized), or each core SDK's share of its
// registry's tracked SDKs. The derived two are ratios of sums, fair on a
// week missing a day, so they break only under MIN_RATIO_DAYS. Shares share
// one y-axis top, so their heights compare.

import { weekColumns, weekValues } from '../../../shared/utils/adoption-weeks'
import { compactCount, count, sharePct } from '#layers/core/shared/utils/terminal-format'
import { LAB_DISPLAY } from '#layers/core/shared/utils/lab-names'
import type { AdoptionData, AdoptionRatioWeek } from '../../../shared/utils/recipe-views'
import type { TableColumn } from '#layers/core/app/types/terminal-ui'

const props = withDefaults(
  defineProps<{
    downloads: AdoptionData['downloads']
    caveat: string
    /** 'sdk' or 'agent' to show one kind. */
    kind?: 'sdk' | 'agent'
    measure?: 'raw' | 'normalized' | 'share'
  }>(),
  { kind: undefined, measure: 'raw' },
)

const MIN_RATIO_DAYS = 4

const stamps = useStamps()

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ’${d.slice(2, 4)}`
const weekLabel = (d: string) => `Week of ${stamps.date(d)}`

interface Week {
  week: string
  days: number
  value: number
  /** Drawn: a full raw week, or a ratio week with MIN_RATIO_DAYS. */
  drawn: boolean
}

const weeksOf = (d: AdoptionData['downloads'][number]): Week[] => {
  if (props.measure === 'raw')
    return d.weekly.map((w) => ({ week: w.week, days: w.days, value: w.total, drawn: !w.partial }))
  const ratio: AdoptionRatioWeek[] = props.measure === 'share' ? d.share : d.normalized
  return ratio.map((w) => ({ ...w, drawn: w.days >= MIN_RATIO_DAYS }))
}

const format = computed(() => (props.measure === 'share' ? sharePct : count))
const tick = computed(() => (props.measure === 'share' ? sharePct : compactCount))
const what = computed(() =>
  props.measure === 'share'
    ? 'share of tracked SDK downloads'
    : props.measure === 'normalized'
      ? 'downloads against npm'
      : 'downloads',
)

const packages = computed(() =>
  props.downloads
    .filter((d) => !props.kind || d.kind === props.kind)
    .map((d) => {
      const weeks = weeksOf(d)
      const drawn = weeks.filter((w) => w.drawn)
      return { ...d, weeks, newest: drawn.at(-1) ?? null }
    })
    .filter((d) => d.weeks.length > 0)
    .sort((a, b) => (b.newest?.value ?? -1) - (a.newest?.value ?? -1)),
)

const yMax = computed(() =>
  props.measure === 'share'
    ? Math.max(...packages.value.flatMap((p) => p.weeks.filter((w) => w.drawn).map((w) => w.value)))
    : undefined,
)

const charts = computed(() =>
  packages.value.map((p) => {
    const x = weekColumns(p.weeks[0]!.week, p.weeks.at(-1)!.week)
    const values =
      props.measure === 'raw'
        ? weekValues(p.weekly, x)
        : (() => {
            const at = new Map(p.weeks.map((w) => [w.week, w]))
            return x.map((c) => (at.get(c)?.drawn ? at.get(c)!.value : null))
          })()
    return { ...p, x, series: [{ id: p.recipe_id, label: p.package, values }] }
  }),
)

/** Where each registry's lines start, for the registries shown. */
const starts = computed(() => {
  const first = (r: 'npm' | 'PyPI') =>
    packages.value
      .filter((p) => p.registry === r)
      .map((p) => p.weeks[0]!.week)
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

const cell = (w: Week | undefined) =>
  !w ? '—' : w.days < 7 ? `${format.value(w.value)} (${w.days} of 7 days)` : format.value(w.value)

const rows = computed(() => {
  const at = new Map(
    packages.value.map((p) => [p.recipe_id, new Map(p.weeks.map((w) => [w.week, w]))]),
  )
  const weeks = [...new Set(packages.value.flatMap((p) => p.weeks.map((w) => w.week)))].sort()
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

const caveatLabel = computed(() =>
  props.measure === 'share'
    ? 'tracked SDKs only'
    : props.measure === 'normalized'
      ? 'against all of npm'
      : 'downloads, not users',
)

const caption = computed(() => {
  const unit =
    props.measure === 'share'
      ? 'SDK share of tracked SDK downloads'
      : props.measure === 'normalized'
        ? 'SDK downloads against npm'
        : props.kind === 'agent'
          ? 'Coding-agent package downloads'
          : 'SDK downloads'
  return `${unit} per week, newest first`
})
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
          :id="`${measure === 'raw' ? 'weekly' : measure}-${c.recipe_id}`"
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
              c.newest ? tick(c.newest.value) : '—'
            }}</span>
          </h3>
          <TerminalLineChart
            v-if="c.x.length > 1"
            :x="c.x"
            :series="c.series"
            :format="format"
            :tick-format="tick"
            :height="140"
            :y-max="yMax"
            :x-label="monthLabel"
            :point-label="weekLabel"
            :title="`${c.package} ${what} on ${c.registry} per week, week of ${stamps.date(c.x[0]!)} to week of ${stamps.date(c.x.at(-1)!)}`"
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
        :caption="caption"
        :columns="columns"
        :rows="rows"
        :row-key="(r) => r.week"
        nested
      />
    </TerminalExpand>

    <TerminalSources :sources="sources" :caveats="[{ text: caveat, label: caveatLabel }]" />
  </div>
</template>
