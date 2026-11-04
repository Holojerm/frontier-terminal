<script setup lang="ts">
// One block of a tear sheet: a ruled heading and its readings. Lighter than
// TerminalPanel (no header strip, no footer) because a printed page has no
// room for chrome, and its sources are numbered at the foot of the sheet.

defineProps<{ id: string; title: string; note?: string | null }>()
</script>

<template>
  <section
    :id="id"
    :aria-labelledby="`${id}-heading`"
    class="min-w-0 space-y-2 break-inside-avoid print:space-y-1"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-default pb-1">
      <h2 :id="`${id}-heading`" class="text-sm text-highlighted">{{ title }}</h2>
      <p v-if="note" class="text-xs text-muted">{{ note }}</p>
    </div>
    <slot />
  </section>
</template>
