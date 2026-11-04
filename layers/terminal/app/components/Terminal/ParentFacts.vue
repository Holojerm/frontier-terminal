<script setup lang="ts">
// What a public parent tags about a private lab in its newest 10-Q or 10-K,
// fact by fact, as the parent reported it. One card per parent.

import { compactUsd, count } from '../../../shared/utils/terminal-format'
import { LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import type { ParentFact, ParentsData } from '../../../shared/utils/recipe-views'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ parents: ParentsData; labs?: string[] }>()

const shown = computed(() =>
  props.parents.parents.filter((p) => !props.labs || props.labs.includes(p.lab)),
)

const value = (f: ParentFact) => {
  if (f.value === null) return f.text ?? ''
  if (f.unit === 'usd') return compactUsd(f.value)
  if (f.unit === 'pure') return `${Math.round(f.value * 1000) / 10}%`
  return count(f.value)
}

const columns: TableColumn[] = [
  { key: 'label', label: 'Fact' },
  { key: 'period', label: 'Period', class: 'whitespace-nowrap' },
  { key: 'value', label: 'As reported', numeric: true },
]
const rowsOf = (p: ParentsData['parents'][number]) =>
  p.facts.map((f) => ({
    key: `${f.key}|${f.date}`,
    label: f.label,
    period: f.span === 'instant' ? `at ${f.date}` : `${f.span} to ${f.date}`,
    value: value(f),
  }))
</script>

<template>
  <div class="space-y-3">
    <div class="grid gap-3" :class="shown.length > 1 ? 'lg:grid-cols-2' : ''">
      <TerminalCard
        v-for="p in shown"
        :id="`parent-${p.recipe_id}`"
        :key="p.recipe_id"
        :title="`${p.parent} on ${LAB_DISPLAY[p.lab]}`"
        :sources="[p.source]"
      >
        <template #meta>
          <span>period to {{ p.period }}</span>
          <code class="text-xs">{{ p.member }}</code>
        </template>
        <TerminalTable
          :caption="`${p.parent}'s tagged facts on ${LAB_DISPLAY[p.lab]}, newest filing`"
          :columns="columns"
          :rows="rowsOf(p)"
          :row-key="(r) => r.key"
          nested
        />
      </TerminalCard>
    </div>
    <TerminalSources :caveats="[{ text: parents.caveat, label: 'the parent’s numbers' }]" />
  </div>
</template>
