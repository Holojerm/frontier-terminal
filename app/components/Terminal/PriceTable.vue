<script setup lang="ts">
// The full catalog: everything the store holds, one row per SKU key, priced
// rows first. Each row carries the delta against its previous revision (from
// the change log) and its own provenance. Batch, long-context and promo
// rows sit here, not in the matrix.

import type { TableColumn } from '@nuxt/ui'

import { money, pctChange, pctLabel } from '#shared/utils/terminal-format'
import type { PriceRowView, PricesData } from '#shared/utils/terminal-types'

const props = defineProps<{ prices: PricesData }>()

const pricedOnly = ref(true)
const provider = ref('all')

const providers = computed(() => [
  { label: 'All providers', value: 'all' },
  ...[...new Set(props.prices.rows.map((r) => r.provider))].map((p) => ({ label: p, value: p })),
])

const rows = computed(() =>
  props.prices.rows.filter((r) => {
    if (provider.value !== 'all' && r.provider !== provider.value) return false
    if (pricedOnly.value && r.input_per_mtok === null && r.output_per_mtok === null) return false
    return true
  }),
)
const hidden = computed(() => props.prices.rows.length - rows.value.length)

const numeric = { class: { th: 'text-right', td: 'text-right font-mono' } }

const columns: TableColumn<PriceRowView>[] = [
  { accessorKey: 'provider', header: 'Provider' },
  { accessorKey: 'model_slug', header: 'Model' },
  { accessorKey: 'tier', header: 'Tier' },
  { accessorKey: 'context_window', header: 'Context' },
  { accessorKey: 'input_per_mtok', header: 'In $/Mtok', meta: numeric },
  { accessorKey: 'cached_input_per_mtok', header: 'Cached in', meta: numeric },
  { accessorKey: 'output_per_mtok', header: 'Out $/Mtok', meta: numeric },
  { id: 'delta', header: 'Δ vs previous' },
  { id: 'window', header: 'Window' },
  { id: 'source', header: 'Source' },
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
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-4 text-sm">
      <UCheckbox v-model="pricedOnly" label="Priced rows only" />
      <UFormField label="Provider" class="flex items-center gap-2" :ui="{ label: 'text-sm' }">
        <USelect v-model="provider" :items="providers" size="sm" class="w-40" />
      </UFormField>
      <span v-if="hidden > 0" class="text-xs text-muted">{{ hidden }} row(s) filtered out</span>
    </div>

    <UTable
      :data="rows"
      :columns="columns"
      :ui="{ td: 'align-top', th: 'whitespace-nowrap' }"
      empty="No rows match the current filter."
    >
      <template #model_slug-cell="{ row }">
        <span
          class="font-mono"
          :class="row.original.removed ? 'text-muted line-through' : 'text-highlighted'"
        >
          {{ row.original.model_slug }}
        </span>
        <TerminalCaveatMark
          v-if="row.original.notes"
          :name="`Notes for ${row.original.model_slug}`"
          :text="row.original.notes"
        />
        <span v-if="row.original.also_listed_by.length" class="block text-xs text-muted">
          also on {{ row.original.also_listed_by.join(', ') }}
        </span>
      </template>
      <template #tier-cell="{ row }">
        <span class="text-muted">{{ row.original.tier ?? '—' }}</span>
      </template>
      <template #context_window-cell="{ row }">
        <span class="text-muted">{{ row.original.context_window ?? '—' }}</span>
      </template>
      <template #input_per_mtok-cell="{ row }">{{ money(row.original.input_per_mtok) }}</template>
      <template #cached_input_per_mtok-cell="{ row }">
        <span class="text-muted">{{ money(row.original.cached_input_per_mtok) }}</span>
      </template>
      <template #output_per_mtok-cell="{ row }">{{ money(row.original.output_per_mtok) }}</template>
      <template #delta-cell="{ row }">
        <span
          v-if="row.original.delta"
          class="text-xs"
          :title="`change detected ${row.original.delta.detected_at}`"
        >
          {{ deltaText(row.original) }}
        </span>
        <span v-else class="text-muted">—</span>
      </template>
      <template #window-cell="{ row }">
        <span
          v-if="row.original.effective_from || row.original.effective_until"
          class="text-xs text-muted"
        >
          {{ row.original.effective_from ?? '…' }} → {{ row.original.effective_until ?? '…' }}
        </span>
        <span v-else class="text-muted">—</span>
      </template>
      <template #source-cell="{ row }">
        <TerminalProvenanceTag
          :source-url="row.original.source_url"
          :fetched-at="row.original.fetched_at"
        />
      </template>
    </UTable>

    <p v-if="!prices.changes_available" class="text-xs text-muted">
      No change events yet, so no deltas: a delta needs two revisions of a row.
    </p>

    <UAlert
      v-if="prices.cross_check"
      color="info"
      variant="soft"
      icon="i-lucide-scale"
      :title="`${prices.cross_check.label}: snapshotted, never shown as a price`"
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
  </div>
</template>
