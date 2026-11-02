<script setup lang="ts">
// Label/value pairs as one `dl` (DESIGN.md › Terminal primitives). `grid`
// sets them in columns, for a header block; `list` sets one pair per line,
// for the computed facts under a reading. A `#<key>` slot replaces a value.

import type { Fact } from '~/types/terminal-ui'

const props = defineProps<{
  items: Fact[]
  layout?: 'grid' | 'list'
  /** Grid columns from `sm` up; four by default. */
  cols?: 2 | 3 | 4
}>()

const GRID = {
  2: 'grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2',
  3: 'grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3',
  4: 'grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4',
} as const

const gridClass = computed(() => GRID[props.cols ?? 4])
</script>

<template>
  <dl class="text-sm" :class="layout === 'list' ? 'space-y-1' : gridClass">
    <div
      v-for="f in items"
      :key="f.key"
      :class="[
        layout === 'list' ? 'flex flex-wrap gap-x-2' : 'space-y-1',
        f.wide && layout !== 'list' ? 'col-span-full' : undefined,
      ]"
    >
      <dt class="text-muted" :class="layout === 'list' ? undefined : 'text-xs'">{{ f.label }}</dt>
      <dd :class="f.mono ? 'font-mono text-default' : 'text-highlighted'">
        <slot :name="f.key">{{ f.value }}</slot>
      </dd>
    </div>
  </dl>
</template>
