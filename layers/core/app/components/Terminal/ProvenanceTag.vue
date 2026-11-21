<script setup lang="ts">
// An always-visible inline citation: the host and a readable age, with the exact
// URL as the link and the exact fetch time in the <time>'s datetime and tooltip.
// In a table cell it is one line (host only, truncated) since the panel's footer
// prints every source. Links are `leading-6`: at text-xs the 16px line box missed
// the 24px target floor (DESIGN.md › Target size).

const props = withDefaults(
  defineProps<{
    sourceUrl: string
    fetchedAt: string
    /** Replaces the host as the link text, where the label names the source already. */
    label?: string
    /** Hide the link and show only the age, where the URL is already linked beside it. */
    stamp?: boolean
    /** One line, age in the tooltip. Defaults to on inside a TerminalTable. */
    compact?: boolean
    /** On one line, print the label instead of the host, where the row prints that host already. */
    named?: boolean
    /**
     * A later read of the source that still showed this datum. fetchedAt only
     * moves when the datum changes, so without this an unchanged price
     * re-read ten minutes ago would read as days old.
     */
    checkedAt?: string | null
    /**
     * When this source began failing every check (Prov.failing_since). The page's
     * "as of" is the newest check of any source, so without this a dead source's
     * last datum looks as current as the rest.
     */
    failingSince?: string | null
  }>(),
  // An explicit undefined default stops Vue casting an absent boolean to
  // false, so "not set" can fall through to the table context.
  { label: undefined, compact: undefined, checkedAt: null, failingSince: null },
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
const failing = computed(() =>
  props.failingSince ? failingSince(stamps.absolute(props.failingSince)) : null,
)
const failingNote = computed(() =>
  props.failingSince
    ? `Every check has failed since ${exactStamp(props.failingSince)}. This is from the last check that worked.`
    : null,
)
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
      :title="`${label ? `${label}\n` : ''}${sourceUrl}\n${exactReading}${failingNote ? `\n${failingNote}` : ''}`"
      class="inline-block max-w-40 truncate leading-6 underline underline-offset-2 hover:text-default"
      >{{ named ? text : hostOf(sourceUrl) }}</a
    >
    <UIcon
      v-if="failing"
      name="i-lucide-triangle-alert"
      class="ml-1 size-3 shrink-0 self-center text-warning"
      aria-hidden="true"
    />
    <time :datetime="datetime" class="sr-only">{{ checkedAt ? reading : `fetched ${age}` }}</time>
    <span v-if="failing" class="sr-only">{{ failing }}</span>
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
    <span v-if="failing" class="text-warning" :title="failingNote ?? undefined">{{ failing }}</span>
  </span>
</template>
