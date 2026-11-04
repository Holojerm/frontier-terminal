<script setup lang="ts">
// Public pull requests opened by each lab's coding agent, per UTC day, from
// GitHub's search API. One row per agent and never a share: each agent
// leaves a different trace, so the counts are trends, not a market.

import { count } from '../../../shared/utils/terminal-format'
import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import type { AdoptionData } from '../../../shared/utils/recipe-views'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ agents: AdoptionData['agent_prs']; caveat: string }>()

const columns: TableColumn[] = [
  { key: 'agent', label: 'Agent' },
  { key: 'lab', label: 'Lab' },
  { key: 'newest', label: 'Newest day', numeric: true },
  { key: 'week', label: '7 days', numeric: true },
  { key: 'days', label: 'Days on record', numeric: true },
  { key: 'query', label: 'Counted by', keep: true },
]

const rows = computed(() =>
  props.agents.map((a) => {
    const last = a.days.at(-1)
    const week = a.days.length >= 7 ? a.days.slice(-7).reduce((n, d) => n + d.value, 0) : null
    return {
      ...a,
      lab: LAB_DISPLAY[a.lab],
      newest: last ? `${count(last.value)} (${last.date})` : '',
      week: week === null ? '—' : count(week),
      days: count(a.days.length),
    }
  }),
)
</script>

<template>
  <div class="space-y-3">
    <TerminalTable
      caption="Public GitHub pull requests per day from each lab’s coding agent"
      :columns="columns"
      :rows="rows"
      :row-key="(r) => r.recipe_id"
      :gap="(r) => r.days === '0'"
      nested
    >
      <template #cell-query="{ row }">
        <code class="text-xs">{{ row.query }}</code>
      </template>
      <template #gap>
        <TerminalGap
          inline
          title="No day counted yet"
          reason="We count them once a day with GitHub’s search API."
        />
      </template>
    </TerminalTable>
    <TerminalSources
      :sources="agents.flatMap((a) => (a.source ? [a.source] : [])).slice(0, 1)"
      :caveats="[{ text: caveat, label: 'one trend per agent' }]"
    />
  </div>
</template>
