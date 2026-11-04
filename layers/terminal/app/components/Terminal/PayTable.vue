<script setup lang="ts">
// Posted US salary bands per lab, as the median band midpoint for all roles,
// research and software engineering, with the middle half and the count
// behind each. The change is against the cell's previous reading, the only
// comparison the caveat allows.

import { compactUsd, count, pctChange, pctLabel } from '../../../shared/utils/terminal-format'
import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import type { PayData } from '../../../shared/utils/recipe-views'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ pay: PayData; labs?: string[] }>()

const columns: TableColumn[] = [
  { key: 'cell', label: 'Board and roles' },
  { key: 'median', label: 'Median midpoint', numeric: true },
  { key: 'range', label: 'Middle half', numeric: true },
  { key: 'n', label: 'Bands', numeric: true },
  { key: 'change', label: 'Change', numeric: true },
]

const boards = computed(() =>
  props.pay.boards.filter((b) => !props.labs || props.labs.includes(b.lab)),
)
const rows = computed(() =>
  boards.value.flatMap((b) =>
    b.cells.map((c) => {
      const ch = c.previous ? pctChange(c.previous.median, c.median) : null
      return {
        id: `${b.lab}|${c.key}`,
        cell: `${LAB_DISPLAY[b.lab]} · ${c.label}`,
        median: compactUsd(c.median),
        range: `${compactUsd(c.p25)}–${compactUsd(c.p75)}`,
        n: `${count(c.n)}${c.key === 'all' ? ` of ${count(b.roles_on_board)}` : ''}`,
        change: ch === null ? `first read ${b.date}` : `${pctLabel(ch)} since ${c.previous!.date}`,
        departments: c.departments,
      }
    }),
  ),
)
</script>

<template>
  <div class="space-y-3">
    <TerminalTable
      caption="Posted US salary bands: median band midpoint per role family"
      :columns="columns"
      :rows="rows"
      :row-key="(r) => r.id"
      nested
    >
      <template #cell-cell="{ row }">
        {{ row.cell }}
        <TerminalCaveatMark
          v-if="row.departments"
          name="departments counted"
          :text="`Departments: ${row.departments.join(', ')}`"
          class="ml-1"
        />
      </template>
    </TerminalTable>
    <TerminalSources
      :sources="boards.map((b) => b.source)"
      :caveats="[{ text: pay.caveat, label: 'bands, not offers' }]"
    />
  </div>
</template>
