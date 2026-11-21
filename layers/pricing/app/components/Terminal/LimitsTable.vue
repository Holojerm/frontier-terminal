<script setup lang="ts">
// One lab's published rate limits, one table per docs page: a row per model
// and tier, a column per metric the page prints. "None" is the page's own
// word for no limit on that metric, kept rather than shown as a zero.

import { count } from '#layers/core/shared/utils/terminal-format'
import type { LimitsData } from '../../../shared/utils/limits'
import type { TableColumn } from '#layers/core/app/types/terminal-ui'

const figures = useFigures()

const props = defineProps<{ pages: LimitsData['pages']; caveat: string }>()

const columnsOf = (p: LimitsData['pages'][number]): TableColumn[] => [
  { key: 'model', label: 'Model' },
  { key: 'tier', label: 'Tier' },
  ...p.metrics.map((m) => ({ key: `m:${m}`, label: m, numeric: true })),
  ...(p.rows.some((r) => r.text) ? [{ key: 'text', label: 'Other limits' }] : []),
]

const fmt = (v: number | null | undefined) =>
  v === undefined ? '' : v === null ? 'None' : v >= 1e6 ? figures.tokens(v) : count(v)

const rowsOf = (p: LimitsData['pages'][number]) =>
  p.rows.map((r) => ({
    id: `${r.model}|${r.tier}`,
    model: r.model,
    tier: r.tier === 'all' ? 'All' : r.tier,
    text: r.text ?? '',
    ...Object.fromEntries(p.metrics.map((m) => [`m:${m}`, fmt(r.values[m])])),
  }))

const pagesShown = computed(() => props.pages)

const changeColumns: TableColumn[] = [
  { key: 'between', label: 'Between copies' },
  { key: 'limit', label: 'Limit' },
  { key: 'before', label: 'Before', numeric: true },
  { key: 'after', label: 'After', numeric: true },
]

const changeRows = (a: NonNullable<LimitsData['pages'][number]['archived']>) =>
  a.changes.map((c) => ({
    id: `${c.window_to}|${c.model}|${c.tier}|${c.metric}`,
    between: `${c.window_from.slice(0, 10)} – ${c.window_to.slice(0, 10)}`,
    limit: `${c.model}, ${c.tier}, ${c.metric}`,
    before: fmt(c.before),
    after: fmt(c.after),
  }))
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
      <template v-if="p.archived">
        <p class="text-xs text-muted">
          Internet Archive copies, {{ p.archived.from.slice(0, 10) }} to
          {{ p.archived.to.slice(0, 10) }}: {{ count(p.archived.copies) }} read,
          {{ count(p.archived.changes.length) }} changes
        </p>
        <TerminalTable
          v-if="p.archived.changes.length"
          :caption="`Changes in archived copies: ${p.covers}`"
          :columns="changeColumns"
          :rows="changeRows(p.archived)"
          :row-key="(r) => r.id"
          nested
        />
      </template>
    </div>
    <TerminalSources :caveats="[{ text: caveat, label: 'stated policy only' }]" />
  </div>
</template>
