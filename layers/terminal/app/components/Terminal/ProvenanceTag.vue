<script setup lang="ts">
// The graded axis, as a component: an always-visible inline citation.
// Compact by design — a full URL and an ISO string on every row buried the
// numbers they were meant to support. What shows is the host and a readable
// age; the exact URL is the link and the exact fetch timestamp is the
// <time>'s datetime and its tooltip, one hover or one click away, never
// dropped.
//
// In a table cell it is one line: the host alone (never the longer label),
// truncated, with the age
// and the exact stamp in the link's tooltip and in a screen-reader-only
// <time>. The panel's footer still prints every source with its age, so a
// row trades a repeated "2h ago" for a row that is one line tall.
//
// Each link is `leading-6`: at text-xs its line box was 16px, under the 24px
// target floor (DESIGN.md › Target size), and these sit stacked in table cells
// and footers where axe found 120+ of them once the pages had real rows.

import { exactStamp, hostOf, relativeStamp } from '../../../shared/utils/terminal-format'

const props = withDefaults(
  defineProps<{
    sourceUrl: string
    fetchedAt: string
    /** Replaces the host as the link text — where the label names the source already. */
    label?: string
    /** Hide the link and show only the age — where the URL is already linked beside it. */
    stamp?: boolean
    /** One line, age in the tooltip. Defaults to on inside a TerminalTable. */
    compact?: boolean
  }>(),
  // An explicit undefined default stops Vue casting an absent boolean to
  // false, so "not set" can fall through to the table context.
  { label: undefined, compact: undefined },
)

const inTable = inject(IN_TERMINAL_TABLE, false)
const oneLine = computed(() => props.compact ?? inTable)

const now = useNow()
const text = computed(() => props.label ?? hostOf(props.sourceUrl))
const age = computed(() => relativeStamp(props.fetchedAt, now.value))
const exact = computed(() => exactStamp(props.fetchedAt))
</script>

<template>
  <span
    v-if="oneLine && !stamp"
    class="relative inline-flex max-w-full items-baseline whitespace-nowrap text-xs text-toned"
  >
    <!-- relative: the sr-only <time> below is absolutely positioned; without a
         positioned parent it escapes a table's scroll box and widens the page. -->
    <a
      :href="sourceUrl"
      target="_blank"
      rel="noopener noreferrer"
      :title="`${label ? `${label}\n` : ''}${sourceUrl}\nfetched ${exact} (${age})`"
      class="inline-block max-w-40 truncate leading-6 underline underline-offset-2 hover:text-default"
      >{{ hostOf(sourceUrl) }}</a
    >
    <time :datetime="fetchedAt" class="sr-only">fetched {{ age }}</time>
  </span>
  <span
    v-else
    class="inline-flex items-baseline gap-x-2 text-xs text-toned"
    :class="oneLine ? 'whitespace-nowrap' : 'flex-wrap'"
  >
    <a
      v-if="!stamp"
      :href="sourceUrl"
      target="_blank"
      rel="noopener noreferrer"
      :title="sourceUrl"
      class="inline-block leading-6 underline underline-offset-2 hover:text-default"
      >{{ text }}</a
    >
    <time :datetime="fetchedAt" :title="`fetched ${exact}`">{{ age }}</time>
  </span>
</template>
