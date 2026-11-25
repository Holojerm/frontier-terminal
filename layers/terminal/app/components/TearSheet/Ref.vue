<script setup lang="ts">
// A footnote number pointing at the sheet's source list. Plain text, not a
// link: on paper a link is nothing, and a column of tiny superscript links
// sits under the 24px target floor (WCAG 2.5.8). The list itself links out.
// A figure resting on several reads (implied spend) passes them all: '3,7'.

const props = defineProps<{ n: number | readonly (number | null)[] | null }>()

const refs = computed(() =>
  [...new Set(Array.isArray(props.n) ? props.n : [props.n])]
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b),
)
</script>

<template>
  <sup v-if="refs.length" class="ml-0.5 font-mono text-xs text-muted"
    ><span class="sr-only">{{ refs.length === 1 ? 'source ' : 'sources ' }}</span
    >{{ refs.join(',') }}</sup
  >
</template>
