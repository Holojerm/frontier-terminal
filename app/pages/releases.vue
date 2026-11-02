<script setup lang="ts">
// The model-release timeline: every SKU first listed on an audited page
// after that page's baseline, newest first. A baseline is a watcher's
// first sight of a page, not a lab's announcement, so its rows are
// excluded and the count of them is stated.

import { absoluteStamp } from '#shared/utils/terminal-format'
import type { ReleasesData } from '#shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Releases',
    summary:
      'Every model SKU first listed on OpenAI, Anthropic, Google, xAI, Meta, or Mistral’s pricing pages since tracking began, newest first, with the price printed beside it and its source URL.',
  },
})

const { data: releases, error } = await useFetch<ReleasesData>('/api/releases')

useSeo({
  title: 'New AI model releases and launch prices',
  description:
    'New model SKUs as they appear on the frontier labs’ own pricing pages: date first seen, launch price per million tokens, and the URL each was read from.',
  dateModified: releases.value?.as_of,
})

const now = useNow()
</script>

<template>
  <TerminalPage
    title="Releases"
    lede="SKUs new on a tracked vendor page, with the price printed beside them that day."
    :as-of="releases?.as_of"
    :error="Boolean(error)"
    error-title="Releases could not be read"
    error-body="The releases endpoint failed to respond."
  >
    <template v-if="releases">
      <TerminalGap
        v-if="releases.rows.length === 0"
        title="No new SKUs since tracking began."
        :reason="
          releases.log_from
            ? `Pages tracked since ${absoluteStamp(releases.log_from, now)}. The baseline records what was already listed; nothing has been added since.`
            : 'No pricing page has been polled yet. The first poll records a baseline; later polls record new listings.'
        "
        :action="{ label: 'See the full catalog', to: '/prices' }"
      />
      <TerminalPanel
        v-else
        id="listings"
        title="Listings"
        :note="`${releases.rows.length} listing${releases.rows.length === 1 ? '' : 's'}${releases.log_from ? ` since ${absoluteStamp(releases.log_from, now)}` : ''}, newest first.`"
        flush
      >
        <TerminalReleaseList :rows="releases.rows" />
        <template v-if="releases.excluded_baseline" #foot>
          {{ releases.excluded_baseline }} baseline rows — SKUs already listed when a page was first
          fetched — are excluded.
        </template>
      </TerminalPanel>
    </template>
  </TerminalPage>
</template>
