<script setup lang="ts">
// One SKU's price over time: every observation the store holds for the
// key — the Internet Archive's captures of the lab's page from before we
// watched it, then the change rows, the current row, and the state as of the
// source's first snapshot — as a step chart and as the point-by-point table
// with the fetch each point was read from.

import { absoluteStamp, money } from '../../../shared/utils/terminal-format'
import { labName } from '../../../shared/utils/terminal-labs'
import { skuLede } from '../../../shared/utils/terminal-ledes'
import type { PriceHistoryData, PricePoint } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

// A dynamic route is one pattern, not N pages, so the sitemap hook skips it;
// server/routes/sitemap.xml.get.ts enumerates the keys itself. These values
// are inert and exist for the per-page invariant scripts/check-seo.ts holds.
definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.6',
    title: 'SKU price history',
    summary: 'One SKU’s price over time, point by point, each with its source URL and fetch time.',
  },
})

const route = useRoute()
const key = String(route.params.key ?? '')

const { data: history, error } = await useFetch<PriceHistoryData>(
  `/api/prices/${encodeURIComponent(key)}`,
)

const upstream = error.value?.statusCode
if (upstream === 404 || upstream === 400) {
  throw createError({ statusCode: 404, statusMessage: 'SKU not found', fatal: true })
}
// A throttled fetch is not a SKU with no history. Falling through renders the
// inline "could not be read" alert under a 200, which is the one answer a
// crawler stores as content — the permalink would enter the index as an empty
// page. Say 429 and it comes back instead.
if (upstream === 429) {
  throw createError({ statusCode: 429, statusMessage: 'Too many requests', fatal: true })
}

const name = computed(() => {
  const h = history.value
  if (!h) return key
  return `${h.model_slug}${h.tier ? ` (${h.tier})` : ''}`
})

// A price series with a source URL on every point is a Dataset, not a page
// that happens to contain numbers, and "what does <model> cost" is the query
// this site most wants to be the answer to. `temporalCoverage` is taken from
// the observations themselves rather than stamped: the interval is only as
// wide as what was actually watched.
const site = useSiteContext()
const points = computed(() => history.value?.points ?? [])
const coverage = computed(() => {
  const all = points.value
  const first = all[0]
  const last = all[all.length - 1]
  if (!first || !last) return null
  // Open-ended while the SKU is still listed: the series has a start and no
  // end until the day it is delisted.
  const closed = history.value?.removed || history.value?.archive_only
  return `${first.at}/${closed ? last.at : '..'}`
})

const lab = history.value ? labName(history.value.provider) : ''
// The current price as one sentence, the form an answer engine quotes.
const summary = computed(() => (history.value ? skuLede(history.value) : null))

useSeo({
  title: `${lab} ${name.value} API pricing history`.trim(),
  description: `Every observed ${lab} API price for ${name.value} per million tokens, point by point, with the source URL and fetch time behind each one.`,
  breadcrumb: [{ name: 'Prices', path: '/prices' }],
  dateModified: history.value?.as_of,
  schema: [
    datasetSchema(site, {
      url: usePageUrl(),
      name: `${name.value} API price history`,
      description: `Every observed list price for ${name.value}, per million tokens, as read from ${labName(history.value?.provider ?? 'the provider')}’s own pricing page, with the source URL and fetch time behind each observation.`,
      dateModified: history.value?.as_of,
      temporalCoverage: coverage.value,
      variableMeasured: ['input_per_mtok', 'cached_input_per_mtok', 'output_per_mtok'],
      rows: points.value.length,
      distribution: [
        {
          encodingFormat: 'application/json',
          contentUrl: `${site.appUrl}/api/prices/${encodeURIComponent(key)}`,
        },
      ],
    }),
  ],
})

const KIND: Record<
  PricePoint['kind'],
  { label: string; color: 'neutral' | 'success' | 'warning' | 'info'; icon: string }
> = {
  archived: { label: 'Internet Archive', color: 'neutral', icon: 'i-lucide-archive' },
  baseline: { label: 'first seen', color: 'info', icon: 'i-lucide-flag' },
  added: { label: 'listed', color: 'success', icon: 'i-lucide-plus' },
  modified: { label: 'revised', color: 'warning', icon: 'i-lucide-pencil' },
  removed: { label: 'delisted', color: 'neutral', icon: 'i-lucide-minus' },
  current: { label: 'current', color: 'neutral', icon: 'i-lucide-check' },
}

const priced = computed(() =>
  (history.value?.points ?? []).filter(
    (p) => p.kind !== 'removed' && (p.input_per_mtok !== null || p.output_per_mtok !== null),
  ),
)

const chart = computed(() => {
  const pts = priced.value
  const series = [
    { id: 'input', label: 'input', values: pts.map((p) => p.input_per_mtok) },
    { id: 'output', label: 'output', values: pts.map((p) => p.output_per_mtok) },
    { id: 'cached', label: 'cached input', values: pts.map((p) => p.cached_input_per_mtok) },
  ].filter((s) => s.values.some((v) => v !== null))
  return { x: pts.map((p) => p.at), series }
})

const archivedCount = computed(() => points.value.filter((p) => p.basis === 'archived').length)

const now = useNow()
const xLabel = (x: string) => absoluteStamp(x, now.value)

/** 'input 2 → 2.5' for a revised point; the non-price fields otherwise. */
const diffText = (p: PricePoint) =>
  p.diff
    .map((d) => `${d.field.replace(/_per_mtok$/, '')} ${d.before ?? '∅'} → ${d.after ?? '∅'}`)
    .join('; ')

const POINT_COLUMNS: TableColumn[] = [
  { key: 'at', label: 'Observed', class: 'whitespace-nowrap' },
  { key: 'kind', label: 'Event' },
  { key: 'input_per_mtok', label: 'In $/Mtok', numeric: true },
  { key: 'cached_input_per_mtok', label: 'Cached in', numeric: true, class: 'text-muted' },
  { key: 'output_per_mtok', label: 'Out $/Mtok', numeric: true },
  { key: 'diff', label: 'What changed', class: 'font-mono text-xs text-muted' },
  { key: 'source', label: 'Source' },
]
</script>

<template>
  <TerminalPage
    :back="{ label: 'Prices', to: '/prices' }"
    :as-of="history?.as_of"
    :error="Boolean(error)"
    error-title="Price history didn’t load"
    error-body="We won’t show an old number in its place. Try reloading in a minute."
  >
    <template #title
      ><span class="font-mono">{{ name }}</span></template
    >
    <template v-if="history" #lede>
      <span v-if="summary" class="mb-1 block text-default">{{ summary }}</span>
      {{ labName(history.provider) }} ·
      <span class="font-mono">{{ history.entity_key }}</span>
      <template v-if="history.context_window"> · {{ history.context_window }} context</template>
      <template v-if="history.removed"> · delisted</template>
      <template v-if="history.archive_only">
        · only in the Internet Archive, from before we started checking the page</template
      >
    </template>

    <!-- Chart and its table side by side from xl: the table is the chart's
         keyboard-reachable twin, so it belongs beside it, not a screen below. -->
    <div v-if="history" class="grid items-start gap-6 xl:grid-cols-2">
      <TerminalPanel
        id="chart"
        title="$ per million tokens"
        :note="`${history.points.length} observation${history.points.length === 1 ? '' : 's'} on record. A price holds until the next observation, so the line steps.`"
      >
        <TerminalLineChart
          v-if="chart.series.length && chart.x.length > 1"
          :x="chart.x"
          :series="chart.series"
          step
          :format="money"
          :x-label="xLabel"
          :title="`${name}: ${chart.series.map((s) => s.label).join(', ')} price per million tokens over ${chart.x.length} observations`"
        />
        <TerminalGap
          v-else-if="chart.series.length"
          title="One priced observation."
          reason="A line needs two. The table below holds the one point and its source."
        />
        <TerminalGap
          v-else
          title="No published price on any observation."
          reason="The vendor’s page lists this SKU without a price."
        />
      </TerminalPanel>

      <TerminalPanel
        id="points"
        title="Point by point"
        note="One observation per row: what the page said, when it was read, and the source URL."
        flush
      >
        <TerminalTable
          caption="Every observation of this SKU with prices and provenance"
          :columns="POINT_COLUMNS"
          :rows="history.points"
          :row-key="(p) => `${p.kind}:${p.at}:${p.source_id}`"
          align="top"
        >
          <template #cell-at="{ row: p }">
            <time :datetime="p.at" :title="p.at">{{ absoluteStamp(p.at, now) }}</time>
          </template>
          <template #cell-kind="{ row: p }">
            <UBadge
              :color="KIND[p.kind].color"
              :icon="KIND[p.kind].icon"
              variant="subtle"
              size="sm"
            >
              {{ KIND[p.kind].label }}
            </UBadge>
          </template>
          <template #cell-input_per_mtok="{ row: p }">{{ money(p.input_per_mtok) }}</template>
          <template #cell-cached_input_per_mtok="{ row: p }">
            {{ money(p.cached_input_per_mtok) }}
          </template>
          <template #cell-output_per_mtok="{ row: p }">{{ money(p.output_per_mtok) }}</template>
          <template #cell-diff="{ row: p }">{{ diffText(p) || '—' }}</template>
          <template #cell-source="{ row: p }">
            <TerminalProvenanceTag
              :label="p.source_id"
              :source-url="p.source_url"
              :fetched-at="p.fetched_at"
            />
          </template>
        </TerminalTable>
        <template #foot>
          <template v-if="archivedCount">
            The {{ archivedCount }} “Internet Archive” point{{ archivedCount === 1 ? '' : 's' }}
            come from the Internet Archive’s copy of the lab’s own pricing page, from before we
            started checking it. Each is the first copy we read that showed that price. We read
            about one copy a week, so a change can be up to a week earlier than shown. The source
            link opens that copy.
          </template>
          A “first seen” point is the price before our first recorded change. It held from our first
          check of the page, and any move in between would show up as its own row. A “current” point
          is the price as of the latest check that changed it.
        </template>
      </TerminalPanel>
    </div>
  </TerminalPage>
</template>
