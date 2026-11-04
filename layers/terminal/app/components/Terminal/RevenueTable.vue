<script setup lang="ts">
// Disclosed revenue as one row per lab: the newest reported period, its
// value, the filing it came from. The front page's reading; every period,
// restatements and the parent/issuer distinction in full are on /revenue.

import { compactUsd, count, periodLabel } from '../../../shared/utils/terminal-format'
import type { RevenueData, RevenueProviderView } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

defineProps<{ revenue: RevenueData }>()

const columns: TableColumn[] = [
  { key: 'display', label: 'Lab', class: 'whitespace-nowrap' },
  { key: 'period', label: 'Newest period', class: 'whitespace-nowrap text-xs' },
  { key: 'value', label: 'Revenue', numeric: true },
  { key: 'filing', label: 'Filing', class: 'whitespace-nowrap text-xs text-muted' },
  { key: 'source', label: 'Source', keep: true },
]

const gapText = (p: RevenueProviderView) =>
  p.disclosure === 'none'
    ? 'No SEC filing reports this lab’s revenue'
    : p.filer?.relation === 'issuer'
      ? 'S-1 filed. No revenue read yet'
      : 'Filer known. No XBRL revenue read yet'
</script>

<template>
  <TerminalTable
    caption="Newest SEC-reported revenue per lab, with the filing it came from"
    :columns="columns"
    :rows="revenue.providers"
    :row-key="(p) => p.provider"
    :gap="(p) => !p.periods[0]"
  >
    <template #cell-display="{ row: p }">
      {{ p.display }}
      <TerminalCaveatMark
        v-if="p.disclosure === 'parent' && p.filer"
        label="parent"
        :text="`${p.filer.entity_name ?? p.filer.ticker ?? ''} (${p.filer.ticker ?? `CIK ${p.filer.cik}`}), consolidated. That’s the whole parent’s revenue, not ${p.display}’s.`"
        class="ml-1"
      />
    </template>
    <template #cell-period="{ row: p }">
      <time :datetime="p.periods[0]!.start">{{ p.periods[0]!.start }}</time> →
      <time :datetime="p.periods[0]!.end">{{ p.periods[0]!.end }}</time>
      <span class="text-muted"> · {{ periodLabel(p.periods[0]!.days) }}</span>
    </template>
    <template #cell-value="{ row: p }">
      <span class="text-highlighted" :title="`USD ${count(p.periods[0]!.val)}`">
        {{ compactUsd(p.periods[0]!.val) }}
      </span>
    </template>
    <template #cell-filing="{ row: p }">
      <a
        :href="p.periods[0]!.filing_url"
        target="_blank"
        rel="noopener noreferrer"
        class="underline underline-offset-2 hover:text-default"
        :title="`Accession ${p.periods[0]!.accession_no} · tag ${p.periods[0]!.tag}`"
        >{{ p.periods[0]!.form }}</a
      >
      filed <time :datetime="p.periods[0]!.filed">{{ p.periods[0]!.filed }}</time>
    </template>
    <template #cell-source="{ row: p }">
      <TerminalSources :sources="p.sources.slice(0, 1)" />
    </template>
    <template #gap="{ row: p }">
      <TerminalGap inline :title="gapText(p)" />
    </template>
  </TerminalTable>
</template>
