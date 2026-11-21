<script setup lang="ts">
// The full catalog: one row per SKU key, priced rows first, each with its delta against the
// previous revision, a sparkline once observed more than once, a link to its own page, and its
// provenance. Batch, long-context and promo rows sit here, not in the matrix.
//
// The page's catalog prints 25 rows at a time, with every row one click away (all of them at
// once, for find-in-page). A lab page prints the rows it is given whole.
//
// A column every filtered row would print as a dash is left out for that filter. A context
// window read from another page on the row's own host links that page by name, so the host
// prints once.

import type { PricesData } from '../../../shared/types/prices'

const watchlist = useWatchlist()
const stamps = useStamps()

const props = defineProps<{
  prices: PricesData
  /** Initial provider filter, e.g. from `/prices?provider=xai`. */
  provider?: string
  /** On a lab page: the rows alone, no filters and no cross-check note. */
  bare?: boolean
  /** The page's primary table: it runs with the page instead of its own scroll box. */
  flow?: boolean
}>()

const pricedOnly = ref(true)
const provider = ref(props.provider ?? 'all')

const providers = computed(() => [
  { label: 'All labs', value: 'all' },
  ...watchlist
    .first([...new Set(props.prices.rows.map((r) => r.provider))], (p) => p)
    .map((p) => ({
      label: labName(p),
      value: p,
    })),
])

const filtered = computed(() =>
  catalogRows(props.prices.rows, { provider: provider.value, pricedOnly: pricedOnly.value }),
)
const hidden = computed(() => props.prices.rows.length - filtered.value.length)

// The page is in `?page=`, and the pager's controls are links: SKU pages are in no sitemap, so
// this table is the only server-rendered link to most of them, and a crawler walks the pager
// to reach the rest. A reader's click stays on the client, with no second fetch.
const route = useRoute()
const showAll = ref(false)
const paged = computed(() =>
  props.bare || showAll.value ? null : catalogPage(filtered.value, Number(route.query.page)),
)
const rows = computed(() => paged.value?.rows ?? filtered.value)

/** The hash starts a new page at the catalog's first row, not where the last one was left. */
const pageLink = (page: number) => ({
  query: { ...route.query, page: page > 1 ? String(page) : undefined },
  hash: '#catalog',
})

// A new filter starts at its first page. It keeps the hash: dropping one scrolls to the top.
watch([provider, pricedOnly], () => {
  if (!props.bare && route.query.page !== undefined)
    void navigateTo(
      { query: { ...route.query, page: undefined }, hash: route.hash },
      { replace: true },
    )
})

const COLUMNS: TableColumn[] = [
  { key: 'provider', label: 'Lab', class: 'whitespace-nowrap text-muted', stack: 'inline' },
  { key: 'model_slug', label: 'Model' },
  { key: 'tier', label: 'Tier', class: 'text-muted', stack: 'inline' },
  { key: 'context_window', label: 'Context', class: 'text-muted' },
  { key: 'input_per_mtok', label: 'In $/Mtok', numeric: true },
  { key: 'cached_input_per_mtok', label: 'Cached in', numeric: true, class: 'text-muted' },
  { key: 'output_per_mtok', label: 'Out $/Mtok', numeric: true },
  { key: 'delta', label: 'Δ vs previous', class: 'text-xs' },
  { key: 'history', label: 'History' },
  { key: 'window', label: 'Window', class: 'whitespace-nowrap text-xs text-muted' },
  { key: 'source', label: 'Source' },
]

/** Columns that only ever read off something a row may lack, and what each needs. */
const SPARSE: Record<string, (r: PriceRowView) => boolean> = {
  delta: (r) => r.delta !== null,
  history: (r) => r.spark !== null,
  window: (r) => Boolean(r.effective_from || r.effective_until),
}

// Read off every filtered row, so the columns hold still from one page to the next.
const columns = computed(() =>
  COLUMNS.filter((c) => !SPARSE[c.key] || filtered.value.some(SPARSE[c.key]!)),
)

/** True when the window's own page sits on the row's host: the second tag would repeat it. */
const sameHost = (r: PriceRowView) =>
  r.context_window_source !== null &&
  hostOf(r.context_window_source.source_url) === hostOf(r.source_url)

/** One phrase describing the newest change on the row, or null when there is none. */
function deltaText(row: PriceRowView): string | null {
  const d = row.delta
  if (!d) return null
  if (d.change_type === 'added') return 'new'
  if (d.change_type === 'removed') return 'delisted'
  const [move] = priceMoves(d)
  return move ? moveText(move) : SAME_PRICE
}
</script>

<template>
  <div class="space-y-3">
    <div v-if="!bare" class="flex flex-wrap items-center gap-4 text-sm">
      <UCheckbox v-model="pricedOnly" label="Priced rows only" />
      <UFormField label="Lab" class="flex items-center gap-2" :ui="{ label: 'text-sm' }">
        <USelect v-model="provider" :items="providers" size="sm" class="w-40" />
      </UFormField>
      <span v-if="hidden > 0" class="text-xs text-muted">{{ hidden }} row(s) filtered out</span>
    </div>

    <!-- Above the rows: below a catalog that runs with the page, nobody reached it. -->
    <UAlert
      v-if="!bare && prices.cross_check"
      color="info"
      variant="soft"
      icon="i-lucide-scale"
      :title="`We keep ${prices.cross_check.label} as a cross-check and don’t show its prices`"
    >
      <template #description>
        <span>{{ prices.cross_check.caveat }}</span>
        <TerminalProvenanceTag
          class="mt-1 block"
          :source-url="prices.cross_check.snapshot.source_url"
          :fetched-at="prices.cross_check.snapshot.fetched_at"
        />
      </template>
    </UAlert>

    <TerminalGap v-if="rows.length === 0" title="No rows match the filter." />
    <TerminalTable
      v-else
      caption="Every SKU we track, with prices in dollars per million tokens, the newest change, and its source"
      :columns="columns"
      :rows="rows"
      :row-key="(r) => r.entity_key"
      row-header="model_slug"
      :edge="false"
      align="top"
      :flow="flow"
      stack
    >
      <template #cell-provider="{ row: r }">{{ labName(r.provider) }}</template>
      <template #cell-tier="{ row: r }">
        <span v-if="r.tier" :title="r.tier">{{ tierLabel(r.tier) }}</span>
      </template>
      <template #cell-model_slug="{ row: r }">
        <!-- No whitespace between the slug and its mark: the mark stays on the
             slug's last line, and a long slug still breaks at its hyphens. -->
        <span
          ><NuxtLink
            :to="`/prices/${r.entity_key}`"
            class="py-1 font-mono underline underline-offset-2"
            :class="r.removed ? 'text-muted line-through' : 'text-highlighted'"
            >{{ r.model_slug }}</NuxtLink
          ><TerminalCaveatMark
            v-if="r.notes"
            :name="`Notes for ${r.model_slug}`"
            :text="r.notes"
            class="ml-1 align-middle"
        /></span>
        <span v-if="r.also_listed_by.length" class="block text-xs text-muted">
          also on {{ r.also_listed_by.join(', ') }}
        </span>
      </template>
      <template #cell-context_window="{ row: r }">
        <!-- The tag's link carries the table's tap padding (36px tall), so the figure centres
             on it with that padding cancelled, and stays on the line of the row's other cells. -->
        <span class="flex items-center gap-x-2 whitespace-nowrap">
          {{ r.context_window ?? '—' }}
          <TerminalProvenanceTag
            v-if="r.context_window_source"
            class="-my-1.5"
            :source-url="r.context_window_source.source_url"
            :fetched-at="r.context_window_source.fetched_at"
            :checked-at="r.context_window_source.checked_at"
            :named="sameHost(r)"
            label="model page"
          />
        </span>
      </template>
      <template #cell-input_per_mtok="{ row: r }">{{ money(r.input_per_mtok) }}</template>
      <template #cell-cached_input_per_mtok="{ row: r }">
        {{ money(r.cached_input_per_mtok) }}
      </template>
      <template #cell-output_per_mtok="{ row: r }">{{ money(r.output_per_mtok) }}</template>
      <template #cell-delta="{ row: r }">
        <span v-if="r.delta" :title="`change detected ${r.delta.detected_at}`">
          {{ deltaText(r) }}
        </span>
        <span v-else class="text-muted">—</span>
      </template>
      <template #cell-history="{ row: r }">
        <NuxtLink
          v-if="r.spark"
          :to="`/prices/${r.entity_key}`"
          class="inline-flex min-h-6 items-center gap-2 text-xs text-muted"
          :title="`${r.revisions} observations of ${r.spark.field.replace(/_per_mtok$/, '')} price. Open the SKU page`"
        >
          <TerminalSparkline :values="r.spark.values" />
          <span>{{ r.revisions }}×</span>
        </NuxtLink>
        <span v-else class="text-muted">—</span>
      </template>
      <template #cell-window="{ row: r }">
        <template v-if="r.effective_from || r.effective_until">
          {{ r.effective_from ? stamps.day(r.effective_from) : '…' }} →
          {{ r.effective_until ? stamps.day(r.effective_until) : '…' }}
        </template>
        <template v-else>—</template>
      </template>
      <template #cell-source="{ row: r }">
        <TerminalProvenanceTag
          :source-url="r.source_url"
          :fetched-at="r.fetched_at"
          :checked-at="r.checked_at"
        />
      </template>
    </TerminalTable>

    <div
      v-if="!bare && filtered.length > CATALOG_PAGE_SIZE"
      class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
    >
      <UPagination
        v-if="paged"
        :page="paged.page"
        :to="pageLink"
        :total="filtered.length"
        :items-per-page="CATALOG_PAGE_SIZE"
        :sibling-count="1"
        show-edges
        size="sm"
        aria-label="Catalog pages"
        :ui="{ first: 'hidden', last: 'hidden' }"
      />
      <span class="flex items-center gap-3 text-xs text-muted">
        <span v-if="paged" aria-live="polite">
          {{ paged.first }}–{{ paged.last }} of {{ filtered.length }}
        </span>
        <UButton
          variant="link"
          color="neutral"
          size="sm"
          class="px-0 text-muted"
          :label="showAll ? `Show ${CATALOG_PAGE_SIZE} a page` : `Show all ${filtered.length}`"
          @click="showAll = !showAll"
        />
      </span>
    </div>

    <p v-if="!prices.changes_available" class="text-xs text-muted">
      No price changes yet. We need two versions of a row to show one.
    </p>
  </div>
</template>
