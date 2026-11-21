<script setup lang="ts">
// "New SKU listed" events, newest first. Each row is one `added` change on
// a model row: the day it was first seen, the price printed beside it then,
// and the fetch it was read from. The model links to the SKU's own page,
// where later reprices live.

import type { ReleaseView } from '../../../shared/types/releases'

defineProps<{
  rows: ReleaseView[]
  /** The page's primary table: it runs with the page instead of its own scroll box. */
  flow?: boolean
}>()

// On a phone a row stacks: the model, then its day, launch price and source.
const columns: TableColumn[] = [
  {
    key: 'seen',
    label: 'First seen',
    class: 'whitespace-nowrap font-mono text-xs text-muted',
    stack: 'inline',
  },
  { key: 'model', label: 'Model' },
  { key: 'price', label: '$/Mtok at launch', numeric: true, stack: 'inline' },
  { key: 'source', label: 'Source', stack: 'inline' },
]

const priced = (r: ReleaseView) => r.input_per_mtok !== null || r.output_per_mtok !== null
const stamps = useStamps()
</script>

<template>
  <TerminalTable
    caption="SKUs first listed on a tracked vendor page, newest first, with the launch price"
    :columns="columns"
    :rows="rows"
    :row-key="(r) => r.change_id"
    row-header="model"
    :flow="flow"
    stack
  >
    <template #cell-seen="{ row: r }">
      <time :datetime="r.first_seen_at" :title="r.first_seen_at">{{
        stamps.date(r.first_seen_at)
      }}</time>
    </template>
    <template #cell-model="{ row: r }">
      <!-- The slug and its note mark never part: a mark that wraps under the
           slug made every row a line taller. -->
      <span class="flex flex-wrap items-baseline gap-x-2">
        <span class="text-muted">{{ labName(r.provider) }}</span>
        <!-- No whitespace between the slug and its mark: the mark stays on the
             slug's last line, and a long slug still breaks at its hyphens. -->
        <span
          ><NuxtLink
            :to="`/prices/${r.entity_key}`"
            class="font-mono text-highlighted underline underline-offset-2"
            >{{ r.model_slug }}</NuxtLink
          ><TerminalCaveatMark
            v-if="r.notes"
            :name="`Notes for ${r.model_slug}`"
            :text="r.notes"
            class="ml-1 align-middle"
        /></span>
      </span>
      <!-- Optional chaining: a payload cached before this field existed may be served for up to five minutes after a deploy. -->
      <span
        v-if="r.tier || r.context_window || r.also_listed_by?.length"
        class="block text-xs text-muted"
      >
        {{
          [
            r.tier ? tierLabel(r.tier) : null,
            r.context_window,
            r.also_listed_by?.length ? `also on ${r.also_listed_by.join(', ')}` : null,
          ]
            .filter(Boolean)
            .join(' · ')
        }}
      </span>
    </template>
    <template #cell-price="{ row: r }">
      <TerminalPrice v-if="priced(r)" :input="r.input_per_mtok" :output="r.output_per_mtok" />
      <TerminalGap v-else inline title="Catalog only, no price listed" />
    </template>
    <template #cell-source="{ row: r }">
      <TerminalProvenanceTag :source-url="r.source_url" :fetched-at="r.fetched_at" />
    </template>
  </TerminalTable>
</template>
