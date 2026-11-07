<script setup lang="ts">
// One side of a track-record row (first press, or the lab's newsroom): the
// matched report with its outlet and time, or the plain reason there is none.

import type {
  TrackRecordRow,
  TrackRecordSide,
  TrackRecordState,
} from '../../../shared/utils/terminal-types'

const props = defineProps<{
  side: TrackRecordSide
  row: TrackRecordRow
  /** Both sides share one search window: the row's second side shows a dash while it is open. */
  quietWindow?: boolean
}>()

const stamps = useStamps()

const STATE_TEXT: Record<Exclude<TrackRecordState, 'matched'>, string> = {
  'window-open': 'Window still open',
  'not-searched': 'Not searched yet',
  'not-searchable': 'Not searched',
  'no-feed': 'No feed',
  'none-found': 'None found',
  'not-yet-rated': 'Not yet rated',
  'no-match': 'No match',
}

const reason = computed(() => {
  const s = props.side
  if (s.state === 'matched') return null
  if (s.state === 'window-open') {
    return props.quietWindow
      ? { text: '—', detail: null }
      : { text: `Searched after ${stamps.absolute(props.row.window_to)}`, detail: null }
  }
  const detail =
    s.state === 'not-yet-rated'
      ? `${s.rated} of ${s.candidates} rated so far.`
      : s.state === 'no-match'
        ? `${s.candidates} found, none the same event.`
        : s.detail
  return { text: STATE_TEXT[s.state], detail }
})
</script>

<template>
  <template v-if="side.hit">
    <a
      :href="side.hit.url"
      target="_blank"
      rel="noopener noreferrer"
      class="text-default underline underline-offset-2 hover:text-primary"
      >{{ side.hit.title }}</a
    >
    <span class="block text-xs text-muted">
      {{ side.hit.outlet }} ·
      <time :datetime="side.hit.published_at" :title="side.hit.published_at">{{
        stamps.absolute(side.hit.published_at)
      }}</time>
    </span>
    <span v-if="side.searched_from" class="block text-xs text-dimmed"
      >Searched only from {{ stamps.absolute(side.searched_from) }}, so not in the tally.</span
    >
  </template>
  <template v-else-if="reason">
    <span class="text-xs text-muted">{{ reason.text }}</span>
    <span v-if="reason.detail" class="block text-xs text-dimmed">{{ reason.detail }}</span>
  </template>
</template>
