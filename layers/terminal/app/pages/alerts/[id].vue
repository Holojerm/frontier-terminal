<script setup lang="ts">
// One alert, at a URL that can be cited: headline, severity, tier, rule,
// the explanation, and every change row it rests on rendered in full with
// its provenance. The Atom feed and every list link here.

import { DESCRIPTION_MAX } from '#shared/utils/seo-bounds'
import { absoluteStamp } from '../../../shared/utils/terminal-format'
import { alertTier } from '../../../shared/utils/terminal-tiers'
import type { AlertDetailData } from '../../../shared/utils/terminal-types'

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
  // Answer with what happened upstream rather than calling everything a server
  // fault. A 429 is the rate limiter working — reporting it as 503 told a
  // crawler the site was down, and, because server/plugins/error-logger.ts
  // spools every 5xx, mailed the owner an ops digest about a healthy limiter.
  // Anything genuinely unexpected keeps its upstream status in the message, so
  // the digest can tell a throttle from a database that has gone away.
  const upstream = error.value?.statusCode
  if (upstream === 404) {
    throw createError({ statusCode: 404, statusMessage: 'No such alert', fatal: true })
  }
  if (upstream === 429) {
    throw createError({ statusCode: 429, statusMessage: 'Too many requests', fatal: true })
  }
  throw createError({
    statusCode: 503,
    statusMessage: `Alert could not be read (upstream ${upstream ?? 'unknown'})`,
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

// The permalink already says `ogType: 'article'`; the graph now agrees. An
// alert is the most quotable thing on this site — a dated claim resting on
// named rows — and WebPage has nowhere to put an author, a publication date,
// or the sources. `citation` carries the same source URLs the page renders
// below, so a quote lands back on the primary documents rather than on us.
const citation = [alert.source_url, ...alert.changes.map((change) => change.source_url)]

useSeo({
  title: alert.headline,
  description: snippet(alert.explanation),
  ogType: 'article',
  breadcrumb: [
    { name: 'Alerts', path: '/alerts' },
    { name: alert.headline, path: `/alerts/${alert.id}` },
  ],
  // An alerts row is append-only, so its creation time is exact and is also
  // the last time anything about it was true.
  dateModified: alert.created_at,
  schema: [
    articleSchema(useSiteContext(), {
      url: usePageUrl(),
      headline: alert.headline,
      description: snippet(alert.explanation),
      datePublished: alert.created_at,
      citation,
    }),
  ],
})
</script>

<template>
  <TerminalPage :back="{ label: 'All alerts', to: '/alerts' }" :title="alert.headline">
    <template #header>
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
        <time :datetime="alert.created_at" :title="alert.created_at" class="text-muted">
          {{ absoluteStamp(alert.created_at) }}
        </time>
      </div>
      <p class="max-w-3xl text-default">{{ alert.explanation }}</p>
      <TerminalSources :sources="[alert]">
        <span class="font-mono break-all">{{ alert.id }}</span>
      </TerminalSources>
    </template>

    <TerminalPanel
      id="cited"
      title="Cited change rows"
      note="Every field of every cited row, before and after."
    >
      <div v-if="alert.changes.length" class="grid gap-3 lg:grid-cols-2">
        <TerminalChangeDetail v-for="change in alert.changes" :key="change.id" :change="change" />
      </div>
      <p v-if="alert.missing_change_ids.length" class="text-sm text-muted">
        {{ alert.missing_change_ids.length }} cited change id(s) are not in the change log:
        <span class="font-mono break-all">{{ alert.missing_change_ids.join(', ') }}</span>
      </p>
      <TerminalGap
        v-if="!alert.changes.length && !alert.missing_change_ids.length"
        title="No change rows cited."
        reason="An alert without cited rows cannot be checked; this one is listed as stored."
      />
    </TerminalPanel>
  </TerminalPage>
</template>
