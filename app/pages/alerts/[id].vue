<script setup lang="ts">
// One alert, at a URL that can be cited: headline, severity, tier, rule,
// the explanation, and every change row it rests on rendered in full with
// its provenance. The Atom feed and every list link here.

import { DESCRIPTION_MAX } from '#shared/utils/seo-bounds'
import { absoluteStamp } from '#shared/utils/terminal-format'
import { alertTier } from '#shared/utils/terminal-tiers'
import type { AlertDetailData } from '#shared/utils/terminal-types'

// Inert for a dynamic route: the collecting hook skips paths with a
// parameter, and server/routes/sitemap.xml.get.ts enumerates the permalinks
// from D1 instead. Declared anyway — the seo gate's invariant is per-page.
definePageMeta({
  publicPage: {
    changefreq: 'yearly',
    priority: '0.6',
    title: 'Alert',
    summary: 'One alert with the change rows it cites, each with its source URL and fetch time.',
  },
})

const route = useRoute()
const id = String(route.params.id ?? '')

const { data, error } = await useFetch<AlertDetailData>(`/api/alerts/${id}`)

if (!data.value) {
  throw createError({
    statusCode: error.value?.statusCode === 404 ? 404 : 503,
    statusMessage: error.value?.statusCode === 404 ? 'No such alert' : 'Alert could not be read',
    fatal: true,
  })
}

const alert = data.value.alert
const tier = alertTier(alert.severity)

/** The explanation is the description; cut at a word if it runs past what a result shows. */
function snippet(text: string): string {
  if (text.length <= DESCRIPTION_MAX) return text
  const cut = text.slice(0, DESCRIPTION_MAX - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 60))}…`
}

useSeo({
  title: alert.headline,
  description: snippet(alert.explanation),
  ogType: 'article',
  breadcrumb: [
    { name: 'Alerts', path: '/alerts' },
    { name: alert.headline, path: `/alerts/${alert.id}` },
  ],
})
</script>

<template>
  <article class="space-y-8">
    <header class="space-y-3">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <UBadge
          :color="SEVERITY_BADGE[alert.severity].color"
          :icon="SEVERITY_BADGE[alert.severity].icon"
          variant="subtle"
          size="sm"
        >
          {{ alert.severity }}
        </UBadge>
        <TerminalCaveatMark :label="tier" :text="TIER_TEXT[tier]" />
        <TerminalCaveatMark :label="alert.rule" :text="RULE_TEXT[alert.rule]" />
        <time :datetime="alert.created_at" :title="alert.created_at" class="ml-auto text-toned">
          {{ absoluteStamp(alert.created_at) }}
        </time>
      </div>
      <h1 class="text-3xl text-highlighted">{{ alert.headline }}</h1>
      <p class="max-w-2xl text-default">{{ alert.explanation }}</p>
      <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <TerminalProvenanceTag :source-url="alert.source_url" :fetched-at="alert.fetched_at" />
        <span class="font-mono text-xs text-toned break-all">{{ alert.id }}</span>
      </div>
    </header>

    <TerminalPanel
      id="cited"
      title="Cited change rows"
      note="An alert is a claim about these rows and may cite nothing else. Every field is shown, before and after; the ones that moved are marked."
    >
      <div v-if="alert.changes.length" class="space-y-4">
        <TerminalChangeDetail v-for="change in alert.changes" :key="change.id" :change="change" />
      </div>
      <p v-if="alert.missing_change_ids.length" class="text-sm text-toned">
        {{ alert.missing_change_ids.length }} cited change id(s) are not in the change log:
        <span class="font-mono break-all">{{ alert.missing_change_ids.join(', ') }}</span>
      </p>
      <TerminalEmptyState
        v-if="!alert.changes.length && !alert.missing_change_ids.length"
        title="No change rows cited."
        body="An alert without cited rows cannot be checked; this one is listed as stored."
      />
    </TerminalPanel>

    <p class="text-sm">
      <NuxtLink to="/alerts" class="text-primary underline underline-offset-2">
        All alerts and the ticker
      </NuxtLink>
    </p>
  </article>
</template>
