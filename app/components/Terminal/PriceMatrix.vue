<script setup lang="ts">
// Like-for-like: one row per provider, one column per question an analyst
// actually asks ("what does their flagship cost?"). The class mapping is
// editorial and labelled as such; every cell carries the vendor sentence
// behind it, and a cell with nothing to show explains itself rather than
// printing a dash.

import { absoluteStamp, money } from '#shared/utils/terminal-format'
import { LAB_DISPLAY as DISPLAY } from '#shared/utils/terminal-labs'
import type { BigFour, MatrixCell, PriceMatrix } from '#shared/utils/terminal-types'

const props = defineProps<{
  matrix: PriceMatrix
  /** Which rows to draw; every provider by default. A lab page draws its own alone. */
  providers?: BigFour[]
  /** Drop the method footnote — the axis page carries it. */
  compact?: boolean
}>()

const rows = computed(() =>
  props.providers
    ? props.matrix.providers.filter((p) => props.providers!.includes(p))
    : props.matrix.providers,
)

function cell(provider: string, klass: string): MatrixCell | undefined {
  return props.matrix.cells.find((c) => c.provider === provider && c.class === klass)
}
</script>

<template>
  <div class="space-y-3">
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <caption class="sr-only">
          Like-for-like API pricing in dollars per million tokens, by provider and class
        </caption>
        <thead>
          <tr class="border-b border-default text-left align-top">
            <th scope="col" class="py-2 pr-4 font-medium text-muted">Provider</th>
            <th v-for="k in matrix.classes" :key="k.id" scope="col" class="py-2 pr-4">
              <span class="font-medium text-highlighted">{{ k.label }}</span>
              <span class="block max-w-48 text-xs font-normal text-muted">{{ k.question }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in rows" :key="p" class="border-b border-default align-top">
            <th scope="row" class="py-3 pr-4 text-left font-medium text-highlighted">
              {{ DISPLAY[p] ?? p }}
            </th>
            <td v-for="k in matrix.classes" :key="k.id" class="py-3 pr-4">
              <template v-if="cell(p, k.id)">
                <div v-if="cell(p, k.id)!.priced" class="space-y-1">
                  <div class="flex items-center gap-1">
                    <span class="font-mono text-default">{{ cell(p, k.id)!.row!.model_slug }}</span>
                    <TerminalCaveatMark
                      v-if="cell(p, k.id)!.basis"
                      :name="`Why ${cell(p, k.id)!.row!.model_slug} is the ${k.label}`"
                      :text="basisText(cell(p, k.id)!, k.label)"
                    />
                  </div>
                  <p v-if="cell(p, k.id)!.basis_current === false" class="text-xs text-warning">
                    Mapping under review — the vendor rewrote its recommendation
                    <span v-if="cell(p, k.id)!.basis_checked_at"
                      >(checked {{ absoluteStamp(cell(p, k.id)!.basis_checked_at!) }})</span
                    >
                  </p>
                  <div class="flex flex-wrap items-baseline gap-x-3 font-mono">
                    <span class="text-highlighted"
                      >{{ money(cell(p, k.id)!.row!.input_per_mtok) }}
                      <span class="text-xs text-muted">in</span></span
                    >
                    <span class="text-default"
                      >{{ money(cell(p, k.id)!.row!.output_per_mtok) }}
                      <span class="text-xs text-muted">out</span></span
                    >
                    <span v-if="cellDelta(cell(p, k.id)!)" class="text-xs text-muted">
                      {{ cellDelta(cell(p, k.id)!) }}
                    </span>
                  </div>
                  <TerminalProvenanceTag
                    :source-url="cell(p, k.id)!.row!.source_url"
                    :fetched-at="cell(p, k.id)!.row!.fetched_at"
                  />
                </div>
                <div v-else class="space-y-1 text-muted">
                  <span v-if="cell(p, k.id)!.row" class="font-mono">
                    {{ cell(p, k.id)!.row!.model_slug }}
                  </span>
                  <div class="flex items-center gap-1 text-xs">
                    <span>{{ cell(p, k.id)!.row ? 'no published price' : 'not mapped' }}</span>
                    <TerminalCaveatMark
                      :name="`Why ${DISPLAY[p] ?? p} has no ${k.label} price`"
                      :text="cell(p, k.id)!.gap ?? ''"
                    />
                  </div>
                  <TerminalProvenanceTag
                    v-if="cell(p, k.id)!.row"
                    :source-url="cell(p, k.id)!.row!.source_url"
                    :fetched-at="cell(p, k.id)!.row!.fetched_at"
                  />
                </div>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="!compact" class="text-xs text-muted">
      {{ matrix.tier_note }} A model sits in a column because the vendor’s own docs recommend it
      there; the info control beside it quotes the sentence.
    </p>
  </div>
</template>
