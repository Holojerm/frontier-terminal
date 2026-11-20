<script setup lang="ts">
// Misalignment disclosure as one row per lab: reports and notices on the
// lab's own index, and the median days from discovery to publication. A lab
// with no index says so and gives the audit's reason: the count measures
// disclosure, so a blank here is the finding, not a zero.
//
// Labs with the same gap share one line after the figures, each name with
// its own reason behind an info control (TerminalTable `foldGaps`): where most
// labs publish no index, eight gap rows were taller than the one row of figures.

import type { DisclosuresData } from '../../../shared/utils/terminal-types'
import type { GapRef, TableColumn } from '../../types/terminal-ui'

const watchlist = useWatchlist()

// Omit the entry list: this table renders the per-lab counts only, and a
// page can drop the array before it is serialised into the hydration payload.
const props = defineProps<{ disclosures: Omit<DisclosuresData, 'entries'> }>()

const days = (n: number) => (Number.isInteger(n) ? `${n}d` : `${n.toFixed(1)}d`)

const columns: TableColumn[] = [
  { key: 'display', label: 'Lab', class: 'whitespace-nowrap' },
  { key: 'reports', label: 'Reports', numeric: true },
  { key: 'notices', label: 'Notices', numeric: true },
  { key: 'median', label: 'Median lag', numeric: true },
  { key: 'source', label: 'Source', keep: true },
]

type Provider = DisclosuresData['providers'][number]

const rows = computed(() => watchlist.first(props.disclosures.providers, (p) => p.provider))
const gapOf = (p: Provider): GapRef => feedGap('disclosures', p) ?? { title: '' }
</script>

<template>
  <TerminalTable
    caption="Misalignment disclosures per lab: reports and notices on the lab’s own index, and median days from discovery to publication"
    :columns="columns"
    :rows="rows"
    :row-key="(p) => p.provider"
    :gap="(p) => p.feed !== 'ok'"
    :fold-gaps="(p) => gapOf(p).title"
    stack
  >
    <template #cell-reports="{ row: p }">
      <span class="text-highlighted">{{ p.reports }}</span>
    </template>
    <template #cell-median="{ row: p }">
      <template v-if="p.median_days_to_disclosure !== null">
        {{ days(p.median_days_to_disclosure) }}
        <span class="text-xs text-muted">over {{ p.timed_reports }}</span>
      </template>
      <span v-else class="text-muted">—</span>
    </template>
    <template #cell-source="{ row: p }">
      <TerminalSources
        :sources="p.sources.slice(0, 1)"
        :caveats="p.caveat ? [{ name: `Caveat for ${p.display} disclosures`, text: p.caveat }] : []"
      />
    </template>
    <template #gap="{ row: p, rows: folded }">
      <TerminalGap v-if="folded" inline :title="gapOf(p).title" />
      <TerminalGap v-else inline v-bind="gapOf(p)" />
    </template>
    <template #fold-name="{ row: p }">
      {{ p.display
      }}<TerminalCaveatMark
        v-if="gapOf(p).reason"
        :name="gapOf(p).name ?? `Why: ${p.display}`"
        :text="gapOf(p).reason!"
        class="-mr-1.5 align-middle"
      />
    </template>
  </TerminalTable>
</template>
