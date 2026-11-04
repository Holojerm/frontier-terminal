<script setup lang="ts">
// One row per rate-limit page: what it covers, when the newest snapshot was
// first seen and whether it changed a limit. The limits themselves are on
// each lab's page (TerminalLimitsTable); this is the capacity view's index.

import { count } from '../../../shared/utils/terminal-format'
import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import type { LimitsData } from '../../../shared/utils/recipe-views'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ limits: LimitsData }>()

const columns: TableColumn[] = [
  { key: 'display', label: 'Lab' },
  { key: 'covers', label: 'Covers' },
  { key: 'limits', label: 'Limits', numeric: true },
  { key: 'change', label: 'Last change' },
]

const rows = computed(() =>
  props.limits.pages.map((p) => ({
    ...p,
    display: LAB_DISPLAY[p.lab],
    limits: count(p.rows.reduce((n, r) => n + Object.keys(r.values).length, 0)),
    change: p.previous
      ? `${count(p.changed)} changed on ${p.snapshot}`
      : `None since first read, ${p.snapshot}`,
  })),
)
</script>

<template>
  <div class="space-y-3">
    <TerminalTable
      caption="Published API rate-limit pages, and when a limit last changed"
      :columns="columns"
      :rows="rows"
      :row-key="(r) => r.recipe_id"
      nested
    >
      <template #cell-display="{ row }">
        <NuxtLink :to="`/labs/${row.lab}#limits`" class="underline underline-offset-2">{{
          row.display
        }}</NuxtLink>
      </template>
    </TerminalTable>
    <TerminalSources
      :sources="limits.pages.map((p) => p.source)"
      :caveats="[{ text: limits.caveat, label: 'policy, not a gauge' }]"
    />
  </div>
</template>
