<script setup lang="ts">
// One panel of the terminal: a heading, an optional one-line note under it,
// and whatever the panel shows. The heading level is a prop so a panel
// nested under a page's h1 stays h2 and the document outline never skips.

defineProps<{
  id: string
  title: string
  note?: string
}>()
</script>

<template>
  <section :id="id" :aria-labelledby="`${id}-heading`" class="space-y-4">
    <header class="space-y-1">
      <h2 :id="`${id}-heading`" class="text-2xl text-highlighted">{{ title }}</h2>
      <p v-if="note" class="text-sm text-muted">{{ note }}</p>
    </header>
    <slot />
  </section>
</template>
