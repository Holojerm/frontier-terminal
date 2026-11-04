<script setup lang="ts">
// Misalignment disclosure as one row per lab: reports and notices on the
// lab's own index, and the median days from discovery to publication. A lab
// with no index is a row that says so and gives the audit's reason: the
// count measures disclosure, so a blank here is the finding, not a zero.
//
// `collapseGaps` states those labs on one line under the table instead, each
// name with its reason behind an info control: where most labs publish no
// index, five gap rows were taller than the one row of figures.

import type { DisclosuresData } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

// Omit the entry list: this table renders the per-lab counts only, and a
// page can drop the array before it is serialised into the hydration payload.
const props = defineProps<{
  disclosures: Omit<DisclosuresData, 'entries'>
  collapseGaps?: boolean
}>()

const days = (n: number) => (Number.isInteger(n) ? `${n}d` : `${n.toFixed(1)}d`)

const columns: TableColumn[] = [
  { key: 'display', label: 'Lab', class: 'whitespace-nowrap' },
  { key: 'reports', label: 'Reports', numeric: true },
  { key: 'notices', label: 'Notices', numeric: true },
  { key: 'median', label: 'Median lag', numeric: true },
  { key: 'source', label: 'Source', keep: true },
]

const rows = computed(() =>
  props.collapseGaps
    ? props.disclosures.providers.filter((p) => p.feed === 'ok')
    : props.disclosures.providers,
)

/** Gap labs grouped by what is missing, for the collapsed line. */
const gapGroups = computed(() => {
  if (!props.collapseGaps) return []
  const groups = new Map<string, { display: string; reason?: string; name?: string }[]>()
  for (const p of props.disclosures.providers) {
    const gap = feedGap('disclosures', p)
    if (!gap) continue
    const list = groups.get(gap.title) ?? []
    list.push({ display: p.display, reason: gap.reason, name: gap.name })
    groups.set(gap.title, list)
  }
  return [...groups].map(([title, labs]) => ({ title, labs }))
})
</script>

<template>
  <div>
    <TerminalTable
      v-if="rows.length"
      caption="Misalignment disclosures per lab: reports and notices on the lab’s own index, and median days from discovery to publication"
      :columns="columns"
      :rows="rows"
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
          :caveats="
            p.caveat ? [{ name: `Caveat for ${p.display} disclosures`, text: p.caveat }] : []
          "
        />
      </template>
      <template #gap="{ row: p }">
        <TerminalGap inline v-bind="feedGap('disclosures', p)!" />
      </template>
    </TerminalTable>
    <p
      v-for="g in gapGroups"
      :key="g.title"
      class="border-t border-default px-3 py-2 text-xs text-muted first:border-t-0"
    >
      {{ g.title }}:
      <template v-for="(l, i) in g.labs" :key="l.display">
        <span class="whitespace-nowrap text-default"
          >{{ l.display
          }}<TerminalCaveatMark
            v-if="l.reason"
            :name="l.name ?? `Why: ${l.display}`"
            :text="l.reason"
            class="ml-1 align-middle" /></span
        >{{ i < g.labs.length - 1 ? ', ' : '' }}
      </template>
    </p>
  </div>
</template>
