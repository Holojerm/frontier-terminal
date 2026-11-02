<script setup lang="ts">
// Misalignment disclosure as one row per lab: reports and notices on the
// lab's own index, and the median days from discovery to publication. A lab
// with no index is a row that says so and gives the audit's reason: the
// count measures disclosure, so a blank here is the finding, not a zero.

import type { DisclosuresData } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

// Omit the entry list: this table renders the per-lab counts only, and a
// page can drop the array before it is serialised into the hydration payload.
defineProps<{ disclosures: Omit<DisclosuresData, 'entries'> }>()

const days = (n: number) => (Number.isInteger(n) ? `${n}d` : `${n.toFixed(1)}d`)

const columns: TableColumn[] = [
  { key: 'display', label: 'Lab', class: 'whitespace-nowrap' },
  { key: 'reports', label: 'Reports', numeric: true },
  { key: 'notices', label: 'Notices', numeric: true },
  { key: 'median', label: 'Median to disclosure', numeric: true },
  { key: 'source', label: 'Source', keep: true },
]
</script>

<template>
  <TerminalTable
    caption="Misalignment disclosures per lab: reports and notices on the lab’s own index, and median days from discovery to publication"
    :columns="columns"
    :rows="disclosures.providers"
    :row-key="(p) => p.provider"
    :gap="(p) => p.feed !== 'ok'"
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
    <template #gap="{ row: p }">
      <TerminalGap inline v-bind="feedGap('disclosures', p)!" />
    </template>
  </TerminalTable>
</template>
