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

import { exactStamp, hostOf } from '../../../shared/utils/terminal-format'

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
    /**
     * A later read of the source that still showed this datum. fetchedAt only
     * moves when the datum changes, so without this an unchanged price
     * re-read ten minutes ago would read as days old.
     */
    checkedAt?: string | null
  }>(),
  // An explicit undefined default stops Vue casting an absent boolean to
  // false, so "not set" can fall through to the table context.
  { label: undefined, compact: undefined, checkedAt: null },
)

const inTable = inject(IN_TERMINAL_TABLE, false)
const oneLine = computed(() => props.compact ?? inTable)

const stamps = useStamps()
const text = computed(() => props.label ?? hostOf(props.sourceUrl))
const age = computed(() => stamps.relative(props.fetchedAt))
const exact = computed(() => exactStamp(props.fetchedAt))
const since = computed(() => `unchanged since ${stamps.absolute(props.fetchedAt)}`)
const reading = computed(() =>
  props.checkedAt ? `checked ${stamps.relative(props.checkedAt)} · ${since.value}` : age.value,
)
const exactReading = computed(() =>
  props.checkedAt
    ? `checked ${exactStamp(props.checkedAt)}\nunchanged since ${exact.value}`
    : `fetched ${exact.value}`,
)
const datetime = computed(() => props.checkedAt ?? props.fetchedAt)
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
      :title="`${label ? `${label}\n` : ''}${sourceUrl}\n${exactReading}`"
      class="inline-block max-w-40 truncate leading-6 underline underline-offset-2 hover:text-default"
      >{{ hostOf(sourceUrl) }}</a
    >
    <time :datetime="datetime" class="sr-only">{{ checkedAt ? reading : `fetched ${age}` }}</time>
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
    <time :datetime="datetime" :title="exactReading">{{ reading }}</time>
  </span>
</template>
