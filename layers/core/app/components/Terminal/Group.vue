<script setup lang="ts">
// A run of panels under one heading: the h2, a one-line note, and a rule, so
// a long page reads as sections. The panels inside pass `:level="3"`.

defineProps<{
  id: string
  title: string
  note?: string
}>()
</script>

<template>
  <section :id="id" :aria-labelledby="`${id}-heading`" class="space-y-6">
    <header class="space-y-1 border-b border-default pb-2">
      <h2 :id="`${id}-heading`" class="text-sm text-highlighted">{{ title }}</h2>
      <p v-if="note" class="text-xs text-muted">{{ note }}</p>
    </header>
    <slot />
  </section>
</template>
