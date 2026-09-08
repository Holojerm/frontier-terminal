<script setup lang="ts">
// The graded axis, as a component: an always-visible inline citation.
// Compact by design — a full URL and an ISO string on every row buried the
// numbers they were meant to support. What shows is the host and a readable
// age; the exact URL is the link and the exact fetch timestamp is the
// <time>'s datetime and its tooltip, one hover or one click away, never
// dropped.

import { exactStamp, hostOf, relativeStamp } from '#shared/utils/terminal-format'

const props = defineProps<{
  sourceUrl: string
  fetchedAt: string
  /** Replaces the host as the link text — where the label names the source already. */
  label?: string
  /** Hide the link and show only the age — where the URL is already linked beside it. */
  stamp?: boolean
}>()

const now = useNow()
const text = computed(() => props.label ?? hostOf(props.sourceUrl))
const age = computed(() => relativeStamp(props.fetchedAt, now.value))
const exact = computed(() => exactStamp(props.fetchedAt))
</script>

<template>
  <span class="inline-flex flex-wrap items-baseline gap-x-2 text-xs text-toned">
    <a
      v-if="!stamp"
      :href="sourceUrl"
      target="_blank"
      rel="noopener noreferrer"
      :title="sourceUrl"
      class="underline underline-offset-2 hover:text-default"
      >{{ text }}</a
    >
    <time :datetime="fetchedAt" :title="`fetched ${exact}`">{{ age }}</time>
  </span>
</template>
