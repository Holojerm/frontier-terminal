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
      'Every model SKU first listed on OpenAI, Anthropic, Google or xAI’s pricing pages since watching began, newest first, with the price printed beside it and its source URL.',
  },
})

useSeo({
  title: 'Releases',
  description:
    'New model SKUs as they appear on the frontier labs’ own pricing pages: date first seen, launch price per million tokens, and the URL each was read from.',
})

const { data: releases, error } = await useFetch<ReleasesData>('/api/releases')

const now = useNow()
</script>

<template>
  <div class="space-y-8">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">Releases</h1>
      <p class="max-w-2xl text-muted">
        A release here is a SKU row appearing on a vendor page that was already being watched — an
        <code class="text-default">added</code> change in the log. The price is the one printed
        beside it that day; later reprices are on the SKU’s own page.
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Releases could not be read"
      description="The releases endpoint failed to respond."
    />

    <template v-else-if="releases">
      <TerminalEmptyState
        v-if="releases.rows.length === 0"
        title="No new SKUs since watching began."
        :body="
          releases.log_from
            ? `Pages have been watched since ${absoluteStamp(releases.log_from, now)}; a baseline records what was already listed, and nothing has been added since.`
            : 'No pricing page has been polled yet. The first poll writes a baseline; a later one can see a new listing.'
        "
        :action="{ label: 'See the full catalog', to: '/prices' }"
      />
      <template v-else>
        <p class="text-sm text-muted">
          {{ releases.rows.length }} listing{{ releases.rows.length === 1 ? '' : 's' }} since
          <time v-if="releases.log_from" :datetime="releases.log_from">
            {{ absoluteStamp(releases.log_from, now) }}</time
          >.
          <template v-if="releases.excluded_baseline">
            {{ releases.excluded_baseline }} baseline rows — SKUs already listed when a page was
            first fetched — are excluded.
          </template>
        </p>
        <TerminalReleaseList :rows="releases.rows" />
      </template>
    </template>
  </div>
</template>
