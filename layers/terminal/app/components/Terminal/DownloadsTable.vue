<script setup lang="ts">
// Package downloads per lab, the newest 28 days against the 28 before, from
// npm and PyPI. A table rather than a chart: the registries count different
// things (npm counts every tarball, pypistats drops mirrors) and the levels
// are not comparable across packages, only each package's own change.

import { compactTokens, pctChange, pctLabel } from '../../../shared/utils/terminal-format'
import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import type { AdoptionData } from '../../../shared/utils/recipe-views'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{
  downloads: AdoptionData['downloads']
  caveat: string
  /** 'sdk' or 'agent' to show one kind. */
  kind?: 'sdk' | 'agent'
}>()

const columns: TableColumn[] = [
  { key: 'package', label: 'Package' },
  { key: 'lab', label: 'Lab' },
  { key: 'registry', label: 'Registry' },
  { key: 'last', label: 'Last 28 days', numeric: true },
  { key: 'change', label: 'vs prior 28', numeric: true },
  { key: 'through', label: 'Through', keep: true },
]

const rows = computed(() =>
  props.downloads
    .filter((d) => !props.kind || d.kind === props.kind)
    .map((d) => {
      const change = pctChange(d.prior_28d, d.last_28d)
      return {
        ...d,
        lab: LAB_DISPLAY[d.lab],
        last: d.last_28d === null ? '' : compactTokens(d.last_28d),
        change: change === null ? '—' : pctLabel(change),
        through: d.through ?? '',
      }
    })
    .sort((a, b) => (b.last_28d ?? -1) - (a.last_28d ?? -1)),
)
const sources = computed(() =>
  props.downloads
    .flatMap((d) => (d.source && (!props.kind || d.kind === props.kind) ? [d.source] : []))
    .slice(0, 2),
)
</script>

<template>
  <div class="space-y-3">
    <TerminalTable
      :caption="
        kind === 'agent'
          ? 'Coding-agent package downloads, last 28 days'
          : 'SDK downloads per lab, last 28 days'
      "
      :columns="columns"
      :rows="rows"
      :row-key="(r) => r.recipe_id"
      :gap="(r) => r.last_28d === null"
      nested
    >
      <template #cell-package="{ row }">
        <a
          :href="row.source?.source_url"
          class="font-mono"
          target="_blank"
          rel="noopener noreferrer"
          >{{ row.package }}</a
        >
      </template>
      <template #gap>
        <TerminalGap inline title="Not 28 days on record yet" />
      </template>
    </TerminalTable>
    <TerminalSources
      :sources="sources"
      :caveats="[{ text: caveat, label: 'downloads, not users' }]"
    >
      <span>Each package links to the download data we read.</span>
    </TerminalSources>
  </div>
</template>
