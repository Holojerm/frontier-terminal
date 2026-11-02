<script setup lang="ts">
// One cited change row, read in full: what the entity was and what it is
// now, field by field, with the fields that moved marked. An alert is a claim
// about these rows and may cite nothing else, so the permalink shows the
// whole record rather than the diff alone — a reader checking the claim
// needs the fields the headline did not mention as much as the ones it did.

import type { ChangeDetailView } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

defineProps<{ change: ChangeDetailView }>()

const EMPTY = '∅'

const COLUMNS: TableColumn[] = [
  { key: 'field', label: 'Field', class: 'font-mono' },
  { key: 'before', label: 'Before', class: 'break-words font-mono' },
  { key: 'after', label: 'After', class: 'break-words font-mono' },
]
</script>

<template>
  <TerminalCard :id="change.id" :sources="[change]">
    <template #title>
      <span class="flex flex-wrap items-center gap-2">
        <UBadge
          :color="CHANGE_BADGE[change.change_type].color"
          :icon="CHANGE_BADGE[change.change_type].icon"
          variant="subtle"
          size="sm"
        >
          {{ change.change_type }} {{ change.entity_type }}
        </UBadge>
        <span class="font-sans text-default">{{ change.summary }}</span>
      </span>
    </template>

    <TerminalTable
      caption="Record fields before and after the change"
      :columns="COLUMNS"
      :rows="change.fields"
      :row-key="(f) => f.field"
      :row-class="(f) => (f.before !== f.after ? 'text-highlighted' : 'text-muted')"
      nested
      align="top"
    >
      <template #cell-field="{ row: f }">
        {{ f.field }}
        <UIcon
          v-if="f.before !== f.after"
          name="i-lucide-arrow-right"
          class="ml-1 inline size-3 align-middle"
          aria-label="changed"
        />
      </template>
      <template #cell-before="{ row: f }">{{ f.before ?? EMPTY }}</template>
      <template #cell-after="{ row: f }">{{ f.after ?? EMPTY }}</template>
    </TerminalTable>

    <template #foot>
      <span class="font-mono break-all">{{ change.entity_key }}</span>
      <span>
        detected <time :datetime="change.detected_at">{{ change.detected_at }}</time>
      </span>
    </template>
  </TerminalCard>
</template>
