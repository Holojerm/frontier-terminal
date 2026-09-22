<script setup lang="ts">
// One SKU's price over time: every observation the store holds for the
// key — the change rows, the current row, and the state as of the source's
// first snapshot — as a step chart and as the point-by-point table with
// the fetch each point was read from.

import { absoluteStamp, money } from '#shared/utils/terminal-format'
import type { PriceHistoryData, PricePoint } from '#shared/utils/terminal-types'

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

const DISPLAY: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  other: 'Other',
}

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
  return `${first.at}/${history.value?.removed ? last.at : '..'}`
})

useSeo({
  title: `${name.value} price history`,
  description: `Every observed API price for ${name.value} per million tokens, point by point, with the source URL and fetch time behind each one.`,
  breadcrumb: [{ name: 'Prices', path: '/prices' }],
  dateModified: history.value?.as_of,
  schema: [
    datasetSchema(site, {
      url: usePageUrl(),
      name: `${name.value} — API price history`,
      description: `Every observed list price for ${name.value}, per million tokens, as read from ${DISPLAY[history.value?.provider ?? 'other'] ?? 'the provider'}’s own pricing page, with the source URL and fetch time behind each observation.`,
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
  baseline: { label: 'first snapshot', color: 'info', icon: 'i-lucide-flag' },
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

const now = useNow()
const xLabel = (x: string) => absoluteStamp(x, now.value)

/** 'input 2 → 2.5' for a revised point; the non-price fields otherwise. */
const diffText = (p: PricePoint) =>
  p.diff
    .map((d) => `${d.field.replace(/_per_mtok$/, '')} ${d.before ?? '∅'} → ${d.after ?? '∅'}`)
    .join('; ')
</script>

<template>
  <div class="space-y-8">
    <header class="space-y-2">
      <p class="text-sm">
        <NuxtLink to="/prices" class="text-primary underline underline-offset-2">Prices</NuxtLink>
      </p>
      <h1 class="text-4xl text-highlighted">
        <span class="font-mono">{{ name }}</span>
      </h1>
      <p v-if="history" class="max-w-2xl text-muted">
        {{ DISPLAY[history.provider] ?? history.provider }} ·
        <span class="font-mono">{{ history.entity_key }}</span>
        <template v-if="history.context_window"> · {{ history.context_window }} context</template>
        <template v-if="history.removed"> · delisted</template>
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Price history could not be read"
      description="The history endpoint failed to respond. Nothing is shown rather than a stale or inferred number."
    />

    <template v-else-if="history">
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
        <TerminalEmptyState
          v-else-if="chart.series.length"
          title="One priced observation."
          body="A line needs two. The table below holds the one point and its source."
        />
        <TerminalEmptyState
          v-else
          title="No published price on any observation."
          body="This SKU is catalog-only on the audited page: the row exists, the number does not."
        />
      </TerminalPanel>

      <TerminalPanel
        id="points"
        title="Point by point"
        note="Each row is one observation: what the page said, when it was read, and the URL it was read from."
      >
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <caption class="sr-only">
              Every observation of this SKU with prices and provenance
            </caption>
            <thead>
              <tr class="border-b border-default text-left">
                <th scope="col" class="py-2 pr-4 font-medium text-muted">Observed</th>
                <th scope="col" class="py-2 pr-4 font-medium text-muted">Event</th>
                <th scope="col" class="py-2 pr-4 text-right font-medium text-muted">In $/Mtok</th>
                <th scope="col" class="py-2 pr-4 text-right font-medium text-muted">Cached in</th>
                <th scope="col" class="py-2 pr-4 text-right font-medium text-muted">Out $/Mtok</th>
                <th scope="col" class="py-2 pr-4 font-medium text-muted">What changed</th>
                <th scope="col" class="py-2 font-medium text-muted">Source</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="p in history.points"
                :key="`${p.kind}:${p.at}:${p.source_id}`"
                class="border-b border-default align-top"
              >
                <td class="py-2 pr-4 whitespace-nowrap">
                  <time :datetime="p.at" :title="p.at">{{ absoluteStamp(p.at, now) }}</time>
                </td>
                <td class="py-2 pr-4">
                  <UBadge
                    :color="KIND[p.kind].color"
                    :icon="KIND[p.kind].icon"
                    variant="subtle"
                    size="sm"
                  >
                    {{ KIND[p.kind].label }}
                  </UBadge>
                </td>
                <td class="py-2 pr-4 text-right font-mono">{{ money(p.input_per_mtok) }}</td>
                <td class="py-2 pr-4 text-right font-mono text-muted">
                  {{ money(p.cached_input_per_mtok) }}
                </td>
                <td class="py-2 pr-4 text-right font-mono">{{ money(p.output_per_mtok) }}</td>
                <td class="py-2 pr-4 font-mono text-xs text-muted">{{ diffText(p) || '—' }}</td>
                <td class="py-2">
                  <TerminalProvenanceTag
                    :label="p.source_id"
                    :source-url="p.source_url"
                    :fetched-at="p.fetched_at"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="text-xs text-muted">
          A “first snapshot” point is the state the earliest change row says came before it, held
          since the source was first fetched: any move in between would be in the log. A “current”
          point is the row as it stands on the newest fetch that rewrote it.
        </p>
      </TerminalPanel>
    </template>
  </div>
</template>
