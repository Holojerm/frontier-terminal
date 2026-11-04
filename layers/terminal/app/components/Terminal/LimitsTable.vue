<script setup lang="ts">
// One lab's published rate limits, one table per docs page: a row per model
// and tier, a column per metric the page prints. "None" is the page's own
// word for no limit on that metric, kept rather than shown as a zero.

import { compactTokens, count } from '../../../shared/utils/terminal-format'
import type { LimitsData } from '../../../shared/utils/recipe-views'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{ pages: LimitsData['pages']; caveat: string }>()

const columnsOf = (p: LimitsData['pages'][number]): TableColumn[] => [
  { key: 'model', label: 'Model' },
  { key: 'tier', label: 'Tier' },
  ...p.metrics.map((m) => ({ key: `m:${m}`, label: m, numeric: true })),
  ...(p.rows.some((r) => r.text) ? [{ key: 'text', label: 'Other limits' }] : []),
]

const fmt = (v: number | null | undefined) =>
  v === undefined ? '' : v === null ? 'None' : v >= 1e6 ? compactTokens(v) : count(v)

const rowsOf = (p: LimitsData['pages'][number]) =>
  p.rows.map((r) => ({
    id: `${r.model}|${r.tier}`,
    model: r.model,
    tier: r.tier === 'all' ? 'All' : r.tier,
    text: r.text ?? '',
    ...Object.fromEntries(p.metrics.map((m) => [`m:${m}`, fmt(r.values[m])])),
  }))

const pagesShown = computed(() => props.pages)
</script>

<template>
  <div class="space-y-4">
    <div v-for="p in pagesShown" :key="p.recipe_id" class="space-y-2">
      <p class="text-xs text-muted">
        {{ p.covers }} · as published {{ p.snapshot
        }}<template v-if="p.previous"
          >, {{ count(p.changed) }} changed since {{ p.previous }}</template
        >
      </p>
      <TerminalTable
        :caption="`Published rate limits: ${p.covers}`"
        :columns="columnsOf(p)"
        :rows="rowsOf(p)"
        :row-key="(r) => r.id"
        nested
      />
      <TerminalSources :sources="[p.source]" />
    </div>
    <TerminalSources :caveats="[{ text: caveat, label: 'stated policy only' }]" />
  </div>
</template>
