<script setup lang="ts">
// The readout: one row per lab, one column per axis, the number and its
// delta and nothing else. This is what an investor glances at and leaves
// with. Every figure links to the lab page section that carries its full
// provenance (layers/terminal/app/utils/readout.ts derives the cells for both).

import { clipHeadline } from '../../../shared/utils/terminal-labs'
import {
  labPath,
  summarizeLab,
  tearSheetPath,
  type LabInputs,
} from '../../../shared/utils/terminal-lab-summary'
import { alertPath } from '../../../shared/utils/terminal-tiers'
import type { LabId } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ labs: readonly LabId[]; data: LabInputs }>()

const stamps = useStamps()
const figures = useFigures()
const watchlist = useWatchlist()

const rows = computed(() =>
  watchlist
    .first(props.labs, (lab) => lab)
    .map((lab) => {
      const s = summarizeLab(lab, props.data)
      return {
        lab,
        display: s.display,
        cells: readoutCells(s, props.data.rankings?.provenance, figures.usd),
        alert: s.alerts[0] ?? null,
      }
    }),
)

const columns: TableColumn[] = [
  { key: 'lab', label: 'Lab' },
  ...READOUT_AXES.map((a) => ({
    key: a,
    label: READOUT_LABEL[a],
    numeric: a !== 'prices' && a !== 'revenue',
    class: 'font-mono',
  })),
  { key: 'alert', label: 'Newest alert', class: 'min-w-48 text-xs' },
]
</script>

<template>
  <TerminalTable
    caption="Each lab’s flagship price, disclosed revenue, demand share, open roles, incidents, and newest alert"
    :columns="columns"
    :rows="rows"
    :row-key="(r) => r.lab"
  >
    <template #cell-lab="{ row }">
      <!-- Two stacked links, so each is at least 24px tall (WCAG 2.5.8). -->
      <NuxtLink
        :to="labPath(row.lab)"
        class="inline-flex min-h-6 items-center whitespace-nowrap font-medium hover:underline hover:underline-offset-2"
      >
        {{ row.display }}
      </NuxtLink>
      <NuxtLink
        :to="tearSheetPath(row.lab)"
        :aria-label="`${row.display} tear sheet`"
        class="flex min-h-6 items-center whitespace-nowrap text-xs text-muted underline underline-offset-2 hover:text-highlighted"
      >
        Tear sheet
      </NuxtLink>
    </template>
    <template v-for="axis in READOUT_AXES" :key="axis" #[`cell-${axis}`]="{ row }">
      <TerminalReadoutValue :cell="row.cells[axis]" />
    </template>
    <template #cell-alert="{ row }">
      <template v-if="row.alert">
        <time :datetime="row.alert.created_at" class="mr-2 whitespace-nowrap font-mono text-muted">
          {{ stamps.relative(row.alert.created_at) }}
        </time>
        <NuxtLink
          :to="alertPath(row.alert.id)"
          :title="row.alert.headline"
          class="text-default underline decoration-1 underline-offset-2 hover:text-highlighted"
        >
          {{ clipHeadline(row.alert.headline, 56) }}
        </NuxtLink>
      </template>
      <span v-else class="text-muted">none</span>
    </template>
  </TerminalTable>
</template>
