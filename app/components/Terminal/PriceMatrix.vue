<script setup lang="ts">
// Like-for-like: one row per provider, one column per question an analyst
// actually asks ("what does their flagship cost?"). The class mapping is
// editorial and labelled as such; every cell carries the vendor sentence
// behind it, and a cell with nothing to show explains itself rather than
// printing a dash.

import { absoluteStamp, money, pctChange, pctLabel } from '#shared/utils/terminal-format'
import type { MatrixCell, PriceMatrix } from '#shared/utils/terminal-types'

const props = defineProps<{ matrix: PriceMatrix }>()

const DISPLAY: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
}

function cell(provider: string, klass: string): MatrixCell | undefined {
  return props.matrix.cells.find((c) => c.provider === provider && c.class === klass)
}

/** The vendor sentence behind a cell, and the last poll's word on whether it is still there. */
function basisText(c: MatrixCell, label: string): string {
  const mapped = `Mapped to “${label}” on the vendor's own words: “${c.basis}” (${c.basis_source_id}).`
  if (c.basis_current === false) return `${mapped} ${c.basis_note ?? ''}`.trim()
  if (c.basis_current === true && c.basis_checked_at) {
    return `${mapped} Sentence confirmed on the page at the ${absoluteStamp(c.basis_checked_at)} poll.`
  }
  return mapped
}

/** Percent move on the input price since the previous revision, when there is one. */
function delta(c: MatrixCell): string | null {
  const d = c.row?.delta
  if (!d || d.change_type !== 'modified') return null
  const pct = pctChange(d.input_before, d.input_after)
  return pct === null ? null : `${pctLabel(pct)} in`
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
          <tr v-for="p in matrix.providers" :key="p" class="border-b border-default align-top">
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
                    <span v-if="delta(cell(p, k.id)!)" class="text-xs text-muted">
                      {{ delta(cell(p, k.id)!) }}
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

    <p class="text-xs text-muted">
      {{ matrix.tier_note }} Class assignment is the one editorial judgment on this page: a model
      sits in a column because the vendor’s own docs recommend it there — open the info control
      beside a model for the sentence and its source. Prices, timestamps and URLs are read from the
      store untouched.
    </p>
  </div>
</template>
