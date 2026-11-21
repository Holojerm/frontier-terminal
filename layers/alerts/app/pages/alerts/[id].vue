<script setup lang="ts">
// One alert, at a URL that can be cited: headline, severity, tier, rule,
// the explanation, and every change row it rests on rendered in full with
// its provenance. The Atom feed and every list link here.

const stamps = useStamps()

// Inert for a dynamic route (the collecting hook skips parameterized paths, and permalinks
// stay out of the sitemap, terminal-page-source.ts), but the seo gate checks every page.
definePageMeta({
  publicPage: {
    changefreq: 'yearly',
    priority: '0.6',
    title: 'Alert',
    summary: 'One alert with the changes it cites, each with its source URL and fetch time.',
  },
})

const route = useRoute()
const id = String(route.params.id ?? '')

const { data, error } = await useFetch<AlertDetailData>(`/api/alerts/${id}`)

if (!data.value) {
  // Answer with the upstream status rather than a blanket 503. A 429 is the rate limiter
  // working; as a 503 it told crawlers the site was down and, since
  // server/plugins/error-logger.ts spools every 5xx, raised an ops alert about a healthy
  // limiter. Anything unexpected keeps its upstream status in the message.
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
// EDGAR's capitals ("NVIDIA CORP") read in the company's case. Only the
// display: the stored headline and the API keep the text as written.
const headline = readableEdgarNames(alert.headline)
const explanation = readableEdgarNames(alert.explanation)
const tier = alertTier(alert.severity)

/** The explanation is the description; cut at a word if it runs past what a result shows. */
function snippet(text: string): string {
  if (text.length <= DESCRIPTION_MAX) return text
  const cut = text.slice(0, DESCRIPTION_MAX - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 60))}…`
}

// An alert is a dated claim resting on named rows, so the graph is an article (matching
// `ogType: 'article'`) with author, dates and sources. `citation` carries the source URLs
// the page renders, so a quote lands on the primary documents.
const citation = [alert.source_url, ...alert.changes.map((change) => change.source_url)]

useSeo({
  title: headline,
  description: snippet(explanation),
  ogType: 'article',
  breadcrumb: [
    { name: 'Alerts', path: '/alerts' },
    { name: headline, path: `/alerts/${alert.id}` },
  ],
  // An alerts row is append-only, so its creation time is exact and is also
  // the last time anything about it was true.
  dateModified: alert.created_at,
  schema: [
    articleSchema(useSiteContext(), {
      url: usePageUrl(),
      headline,
      description: snippet(explanation),
      datePublished: alert.created_at,
      citation,
    }),
  ],
})
</script>

<template>
  <TerminalPage :back="{ label: 'All alerts', to: '/alerts' }" :title="headline">
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
          {{ stamps.absolute(alert.created_at) }}
        </time>
      </div>
      <p class="max-w-3xl text-default">{{ explanation }}</p>
      <TerminalSources :sources="[alert]">
        <span class="font-mono break-all">{{ alert.id }}</span>
      </TerminalSources>
    </template>

    <TerminalPanel
      id="cited"
      title="Cited changes"
      note="Every field of each cited change, before and after."
    >
      <div v-if="alert.changes.length" class="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        <TerminalChangeDetail v-for="change in alert.changes" :key="change.id" :change="change" />
      </div>
      <p v-if="alert.missing_change_ids.length" class="text-sm text-muted">
        {{ alert.missing_change_ids.length }} cited change ID(s) aren’t in the change log:
        <span class="font-mono break-all">{{ alert.missing_change_ids.join(', ') }}</span>
      </p>
      <TerminalGap
        v-if="!alert.changes.length && !alert.missing_change_ids.length"
        title="No changes cited."
        reason="Without cited changes, this alert can’t be checked. It’s shown as stored."
      />
    </TerminalPanel>
  </TerminalPage>
</template>
