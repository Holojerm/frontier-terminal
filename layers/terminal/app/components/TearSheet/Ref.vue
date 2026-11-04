<script setup lang="ts">
// A footnote number pointing at the sheet's source list. Plain text, not a
// link: on paper a link is nothing, and a column of tiny superscript links
// sits under the 24px target floor (WCAG 2.5.8). The list itself links out.

defineProps<{ n: number | null }>()
</script>

<template>
  <sup v-if="n !== null" class="ml-0.5 font-mono text-xs text-muted"
    ><span class="sr-only">source </span>{{ n }}</sup
  >
</template>
