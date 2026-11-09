<script setup lang="ts">
// One labelled reading (DESIGN.md › Terminal primitives): the label, the
// value in the data face, its delta as a visible sign, a sub-line, and the
// citation. A figure with nothing to show states the gap in its place.
// Renders a dt/dd pair, so it sits inside a parent `<dl>`.

defineProps<{
  label: string
  value?: string | null
  delta?: string | null
  sub?: string | null
  /** The fuller reading this figure summarizes. */
  to?: string
  source?: { source_url: string; fetched_at: string; label?: string } | null
  gap?: { title: string; reason?: string } | null
}>()
</script>

<template>
  <div class="min-w-0 space-y-1">
    <dt class="text-xs text-muted">{{ label }}</dt>
    <dd class="space-y-1">
      <p v-if="value && !gap" class="flex flex-wrap items-baseline gap-x-2">
        <NuxtLink
          v-if="to"
          :to="to"
          class="min-w-6 font-mono text-lg text-highlighted sm:text-xl hover:underline hover:underline-offset-2"
        >
          {{ value }}
        </NuxtLink>
        <span v-else class="font-mono text-lg text-highlighted sm:text-xl">{{ value }}</span>
        <span v-if="delta" class="font-mono text-xs text-muted">{{ delta }}</span>
      </p>
      <TerminalGap v-else-if="gap" inline :title="gap.title" :reason="gap.reason" />
      <p v-if="sub" class="text-xs text-muted">{{ sub }}</p>
      <TerminalProvenanceTag
        v-if="source"
        :label="source.label"
        :source-url="source.source_url"
        :fetched-at="source.fetched_at"
      />
    </dd>
  </div>
</template>
