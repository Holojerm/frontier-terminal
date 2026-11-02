<script setup lang="ts">
// Like-for-like: one row per provider, one column per question an analyst
// actually asks ("what does their flagship cost?"). The class mapping is
// editorial and labelled as such; every cell carries the vendor sentence
// behind it, and a cell with nothing to show explains itself rather than
// printing a dash.

import { LAB_DISPLAY } from '#shared/utils/terminal-labs'
import type { LabId, MatrixCell, PriceMatrix } from '#shared/utils/terminal-types'
import type { TableColumn } from '~/types/terminal-ui'

const props = defineProps<{
  matrix: PriceMatrix
  /** Which rows to draw; every provider by default. A lab page draws its own alone. */
  providers?: LabId[]
}>()

const rows = computed(() =>
  (props.providers
    ? props.matrix.providers.filter((p) => props.providers!.includes(p))
    : props.matrix.providers
  ).map((p) => ({
    provider: p,
    display: LAB_DISPLAY[p] ?? p,
    cells: Object.fromEntries(
      props.matrix.classes.map((k) => [
        k.id,
        props.matrix.cells.find((c) => c.provider === p && c.class === k.id),
      ]),
    ) as Record<string, MatrixCell | undefined>,
  })),
)

const columns = computed<TableColumn[]>(() => [
  { key: 'display', label: 'Lab' },
  ...props.matrix.classes.map((k) => ({ key: k.id, label: k.label, hint: k.question })),
])
</script>

<template>
  <TerminalTable
    caption="Like-for-like API pricing in dollars per million tokens, by lab and class"
    :columns="columns"
    :rows="rows"
    :row-key="(r) => r.provider"
    align="top"
  >
    <template v-for="k in matrix.classes" :key="k.id" #[`cell-${k.id}`]="{ row }">
      <TerminalPriceCell
        v-if="row.cells[k.id]"
        :cell="row.cells[k.id]!"
        :label="k.label"
        :lab="row.display"
      />
    </template>
  </TerminalTable>
</template>
