<script setup lang="ts">
// The full catalog: everything the store holds, one row per SKU key, priced
// rows first. Each row carries the delta against its previous revision (from
// the change log), a sparkline once it has been observed more than once, a
// link to its own page, and its provenance. Batch, long-context and promo
// rows sit here, not in the matrix.

import { money, pctChange, pctLabel } from '../../../shared/utils/terminal-format'
import { labName } from '../../../shared/utils/terminal-labs'
import type { PriceRowView, PricesData } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

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
  ...[...new Set(props.prices.rows.map((r) => r.provider))].map((p) => ({
    label: labName(p),
    value: p,
  })),
])

const rows = computed(() =>
  props.prices.rows.filter((r) => {
    if (provider.value !== 'all' && r.provider !== provider.value) return false
    if (pricedOnly.value && r.input_per_mtok === null && r.output_per_mtok === null) return false
    return true
  }),
)
const hidden = computed(() => props.prices.rows.length - rows.value.length)

const columns: TableColumn[] = [
  { key: 'provider', label: 'Lab', class: 'whitespace-nowrap text-muted' },
  { key: 'model_slug', label: 'Model' },
  { key: 'tier', label: 'Tier', class: 'text-muted' },
  { key: 'context_window', label: 'Context', class: 'text-muted' },
  { key: 'input_per_mtok', label: 'In $/Mtok', numeric: true },
  { key: 'cached_input_per_mtok', label: 'Cached in', numeric: true, class: 'text-muted' },
  { key: 'output_per_mtok', label: 'Out $/Mtok', numeric: true },
  { key: 'delta', label: 'Δ vs previous', class: 'text-xs' },
  { key: 'history', label: 'History' },
  { key: 'window', label: 'Window', class: 'whitespace-nowrap text-xs text-muted' },
  { key: 'source', label: 'Source' },
]

/** One phrase describing the newest change on the row, or null when there is none. */
function deltaText(row: PriceRowView): string | null {
  const d = row.delta
  if (!d) return null
  if (d.change_type === 'added') return 'new'
  if (d.change_type === 'removed') return 'delisted'
  const input = pctChange(d.input_before, d.input_after)
  if (input !== null)
    return `in ${money(d.input_before)} → ${money(d.input_after)} (${pctLabel(input)})`
  const output = pctChange(d.output_before, d.output_after)
  if (output !== null) {
    return `out ${money(d.output_before)} → ${money(d.output_after)} (${pctLabel(output)})`
  }
  return 'modified (non-price field)'
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

    <!-- Above the rows: under a catalog that runs with the page, nobody
         reached it. -->
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
    >
      <template #cell-provider="{ row: r }">{{ labName(r.provider) }}</template>
      <template #cell-model_slug="{ row: r }">
        <!-- No whitespace between the slug and its mark: the mark stays on the
             slug's last line, and a long slug still breaks at its hyphens. -->
        <span
          ><NuxtLink
            :to="`/prices/${r.entity_key}`"
            class="font-mono underline underline-offset-2"
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
        {{ r.context_window ?? '—' }}
        <span v-if="r.context_window_source" class="block">
          <TerminalProvenanceTag
            :source-url="r.context_window_source.source_url"
            :fetched-at="r.context_window_source.fetched_at"
            label="window source"
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
          class="inline-flex items-center gap-2 text-xs text-muted"
          :title="`${r.revisions} observations of ${r.spark.field.replace(/_per_mtok$/, '')} price. Open the SKU page`"
        >
          <TerminalSparkline :values="r.spark.values" />
          <span>{{ r.revisions }}×</span>
        </NuxtLink>
        <span v-else class="text-muted">—</span>
      </template>
      <template #cell-window="{ row: r }">
        <template v-if="r.effective_from || r.effective_until">
          {{ r.effective_from ?? '…' }} → {{ r.effective_until ?? '…' }}
        </template>
        <template v-else>—</template>
      </template>
      <template #cell-source="{ row: r }">
        <TerminalProvenanceTag :source-url="r.source_url" :fetched-at="r.fetched_at" />
      </template>
    </TerminalTable>

    <p v-if="!prices.changes_available" class="text-xs text-muted">
      No price changes yet. We need two versions of a row to show one.
    </p>
  </div>
</template>
