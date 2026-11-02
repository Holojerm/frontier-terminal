<script setup lang="ts">
// One cell of the like-for-like matrix: the model the vendor's own words put
// in this class, its in/out price and move, and its source — or, with nothing
// to price, the stated gap. The info control quotes the vendor sentence
// behind the placement (app/utils/price-display.ts).

import { absoluteStamp } from '#shared/utils/terminal-format'
import type { MatrixCell } from '#shared/utils/terminal-types'

const props = defineProps<{
  cell: MatrixCell
  /** The class's label, e.g. "Flagship". */
  label: string
  /** The lab's display name, for the gap control's accessible name. */
  lab: string
}>()

const row = computed(() => props.cell.row)
const delta = computed(() => cellDelta(props.cell))
</script>

<template>
  <div class="space-y-1">
    <div v-if="row" class="flex items-center gap-1 font-mono text-xs text-default">
      <span class="truncate">{{ row.model_slug }}</span>
      <TerminalCaveatMark
        v-if="cell.priced && cell.basis"
        :name="`Why ${row.model_slug} is the ${label}`"
        :text="basisText(cell, label)"
      />
    </div>
    <p v-if="cell.basis_current === false" class="text-xs text-warning">
      Mapping under review: the cited sentence is no longer on the vendor page<template
        v-if="cell.basis_checked_at"
      >
        (checked {{ absoluteStamp(cell.basis_checked_at) }})</template
      >
    </p>
    <p v-if="cell.priced && row">
      <TerminalPrice :input="row.input_per_mtok" :output="row.output_per_mtok" />
      <span v-if="delta" class="ml-2 font-mono text-xs text-muted">{{ delta }}</span>
    </p>
    <TerminalGap
      v-else
      inline
      :title="row ? 'No published price' : 'Not mapped'"
      :reason="cell.gap ?? undefined"
      :name="`Why ${lab} has no ${label} price`"
    />
    <TerminalProvenanceTag v-if="row" :source-url="row.source_url" :fetched-at="row.fetched_at" />
  </div>
</template>
