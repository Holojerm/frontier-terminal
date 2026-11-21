<script setup lang="ts">
// One cell of the like-for-like matrix, on one line: the model the vendor's
// own words put in this class, its in/out price and move — or, with nothing
// to price, the stated gap. The info control quotes the vendor sentence
// behind the placement (layers/pricing/app/utils/price-display.ts).
//
// The model name is the citation: it links to the pricing page the price was
// read from, with the host and the exact read in its tooltip and a
// screen-reader <time>. The matrix's foot prints each page with its age, so a
// cell trades a third line for a row that is one line tall.

import { exactStamp, hostOf } from '#layers/core/shared/utils/terminal-format'
import type { MatrixCell } from '../../../shared/types/prices'

const stamps = useStamps()

const props = defineProps<{
  cell: MatrixCell
  /** The class's label, e.g. "Flagship". */
  label: string
  /** The lab's display name, for the gap control's accessible name. */
  lab: string
}>()

const row = computed(() => props.cell.row)
const delta = computed(() => cellDelta(props.cell))

const read = computed(() => {
  const r = row.value
  if (!r) return null
  return {
    tip: `${hostOf(r.source_url)}\n${r.source_url}\n${
      r.checked_at
        ? `checked ${exactStamp(r.checked_at)}\nunchanged since ${exactStamp(r.fetched_at)}`
        : `fetched ${exactStamp(r.fetched_at)}`
    }`,
    datetime: r.checked_at ?? r.fetched_at,
    text: `${hostOf(r.source_url)}, ${r.checked_at ? 'checked' : 'fetched'} ${stamps.relative(r.checked_at ?? r.fetched_at)}`,
  }
})

const reviewText = computed(
  () =>
    `Mapping under review. The sentence we cite is no longer on the vendor’s page${
      props.cell.basis_checked_at
        ? ` (checked ${stamps.absolute(props.cell.basis_checked_at)})`
        : ''
    }.`,
)
</script>

<template>
  <span class="flex flex-wrap items-baseline gap-x-2">
    <span v-if="row && read" class="relative inline-flex items-baseline whitespace-nowrap">
      <a
        :href="row.source_url"
        target="_blank"
        rel="noopener noreferrer"
        :title="read.tip"
        class="font-mono text-xs text-default underline decoration-dotted underline-offset-2 hover:text-highlighted"
        >{{ row.model_slug }}</a
      >
      <time :datetime="read.datetime" class="sr-only">{{ read.text }}</time>
      <TerminalCaveatMark
        v-if="cell.priced && cell.basis"
        :name="`Why ${row.model_slug} is the ${label}`"
        :text="basisText(cell, label, stamps.absolute)"
        class="ml-1 self-center"
      />
    </span>
    <TerminalCaveatMark
      v-if="cell.basis_current === false"
      label="under review"
      :text="reviewText"
    />
    <template v-if="cell.priced && row">
      <TerminalPrice :input="row.input_per_mtok" :output="row.output_per_mtok" />
      <span v-if="delta" class="whitespace-nowrap font-mono text-xs text-muted">{{ delta }}</span>
    </template>
    <TerminalGap
      v-else
      inline
      :title="row ? 'No published price' : 'Not mapped'"
      :reason="cell.gap ?? undefined"
      :name="`Why ${lab} has no ${label} price`"
    />
  </span>
</template>
