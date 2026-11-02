<script setup lang="ts">
// "New SKU listed" events, newest first. Each row is one `added` change on
// a model row: the day it was first seen, the price printed beside it then,
// and the fetch it was read from. The model links to the SKU's own page,
// where later reprices live.

import { labName } from '#shared/utils/terminal-labs'
import type { ReleaseView } from '#shared/utils/terminal-types'
import type { TableColumn } from '~/types/terminal-ui'

defineProps<{ rows: ReleaseView[] }>()

const columns: TableColumn[] = [
  { key: 'seen', label: 'First seen', class: 'whitespace-nowrap font-mono text-xs text-muted' },
  { key: 'model', label: 'Model' },
  { key: 'price', label: '$/Mtok at launch', numeric: true },
  { key: 'source', label: 'Source' },
]

const priced = (r: ReleaseView) => r.input_per_mtok !== null || r.output_per_mtok !== null
</script>

<template>
  <TerminalTable
    caption="SKUs first listed on a tracked vendor page, newest first, with the launch price"
    :columns="columns"
    :rows="rows"
    :row-key="(r) => r.change_id"
    row-header="model"
  >
    <template #cell-seen="{ row: r }">
      <time :datetime="r.first_seen_at" :title="r.first_seen_at">{{
        r.first_seen_at.slice(0, 10)
      }}</time>
    </template>
    <template #cell-model="{ row: r }">
      <span class="flex flex-wrap items-center gap-x-2">
        <span class="text-muted">{{ labName(r.provider) }}</span>
        <NuxtLink
          :to="`/prices/${r.entity_key}`"
          class="font-mono text-highlighted underline underline-offset-2"
        >
          {{ r.model_slug }}
        </NuxtLink>
        <TerminalCaveatMark v-if="r.notes" :name="`Notes for ${r.model_slug}`" :text="r.notes" />
      </span>
      <!-- Optional chaining: a payload cached before this field existed may be served for up to five minutes after a deploy. -->
      <span
        v-if="r.tier || r.context_window || r.also_listed_by?.length"
        class="block text-xs text-muted"
      >
        {{
          [
            r.tier,
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
      <TerminalGap v-else inline title="Catalog only; no price printed" />
    </template>
    <template #cell-source="{ row: r }">
      <TerminalProvenanceTag :source-url="r.source_url" :fetched-at="r.fetched_at" />
    </template>
  </TerminalTable>
</template>
