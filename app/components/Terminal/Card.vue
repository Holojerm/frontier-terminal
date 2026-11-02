<script setup lang="ts">
// One lab, one filing, one claim: a bordered tile inside a panel (DESIGN.md ›
// Terminal primitives). A title row with a meta slot on the right — a badge,
// a count — then the body, then the sources. The heading is `h3` under a
// panel and `h2` where the card sits directly under the page title.

import type { Citation } from '~/types/terminal-ui'

withDefaults(
  defineProps<{
    id: string
    title?: string
    level?: 2 | 3 | 4
    sources?: Citation[]
  }>(),
  { title: undefined, level: 3, sources: () => [] },
)
</script>

<template>
  <article
    :id="id"
    :aria-labelledby="`${id}-title`"
    class="min-w-0 space-y-3 rounded border border-default p-3"
  >
    <header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <component :is="`h${level}`" :id="`${id}-title`" class="min-w-0 text-sm text-highlighted">
        <slot name="title">{{ title }}</slot>
      </component>
      <div v-if="$slots.meta" class="flex flex-wrap items-center gap-2 text-xs text-muted">
        <slot name="meta" />
      </div>
    </header>

    <slot />

    <TerminalSources v-if="sources.length || $slots.foot" :sources="sources">
      <slot name="foot" />
    </TerminalSources>
  </article>
</template>
