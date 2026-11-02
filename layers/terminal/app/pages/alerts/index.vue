<script setup lang="ts">
// Every alert, newest first, split by materiality: the alerts (notable,
// critical) lead, the ticker (info) follows as one line each. Each headline
// is a permalink to the alert with its cited rows in full. The Atom feed at
// /alerts.xml carries the alerts; ?include=ticker adds the ticker.

import { TICKER_FEED_QUERY } from '../../../shared/utils/terminal-tiers'
import type { AlertsData } from '../../../shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.9',
    title: 'Alerts',
    summary:
      'Alerts raised on the change log, split by materiality: notable and critical alerts, then the info-tier ticker. Each cites its change rows and source. Atom at /alerts.xml (add ?include=ticker for the ticker).',
  },
})

const [{ data: alerts, error: alertsError }, { data: ticker, error: tickerError }] =
  await Promise.all([
    useFetch<AlertsData>('/api/alerts', { query: { tier: 'alert' } }),
    useFetch<AlertsData>('/api/alerts', { query: { tier: 'ticker' } }),
  ])

useSeo({
  title: 'AI lab pricing, hiring, and filing alerts',
  description:
    'Every alert raised on pricing, hiring, and SEC changes at the frontier AI labs, split into alerts and a ticker, each citing its change rows and sources.',
  dateModified: alerts.value?.as_of,
})

const failed = computed(() => Boolean(alertsError.value || tickerError.value))

// The page holds every alert the endpoint returned; the reader sees a page
// of rows at a time. "Show more" rather than a scroll region: a long list
// stays in the document, where find-in-page and a crawler can reach it.
const PAGE = 25
const shownCount = ref(PAGE)
const shown = computed(() => alerts.value?.rows.slice(0, shownCount.value) ?? [])
const remaining = computed(() => (alerts.value?.rows.length ?? 0) - shown.value.length)
const tickerFeed = `/alerts.xml?${TICKER_FEED_QUERY}`
</script>

<template>
  <TerminalPage
    title="Alerts"
    lede="Alerts are material changes: a price move, a new SKU, a hiring shift, a filing. The ticker lists minor changes. Each cites the change rows it rests on."
    :as-of="alerts?.as_of"
    :error="failed"
    error-title="Alerts could not be read"
    error-body="The alerts endpoint failed to respond. The section that did load is shown."
  >
    <template #header>
      <p class="text-sm text-muted">
        <NuxtLink to="/alerts.xml" external class="text-primary underline underline-offset-2">
          Atom feed</NuxtLink
        >
        ·
        <NuxtLink
          :to="tickerFeed"
          external
          class="font-mono text-primary underline underline-offset-2"
          >?{{ TICKER_FEED_QUERY }}</NuxtLink
        >
        adds the ticker.
      </p>
    </template>

    <TerminalPanel
      id="alerts"
      title="Alerts"
      note="Notable and critical, newest first."
      :flush="Boolean(alerts?.rows.length)"
    >
      <template v-if="alerts">
        <TerminalGap
          v-if="alerts.rows.length === 0"
          title="No alerts yet."
          reason="Alerts are raised on change rows that meet the materiality bar. An empty list after a baseline is expected."
          :action="{ label: 'Recent changes', to: '/#signal' }"
        />
        <TerminalSignalTable v-else :alerts="shown" />
      </template>
      <template v-if="alerts?.rows.length" #foot>
        <span class="flex flex-wrap items-baseline gap-x-4">
          <UButton
            v-if="remaining > 0"
            variant="link"
            size="sm"
            class="px-0"
            :label="`Show ${Math.min(PAGE, remaining)} more`"
            @click="shownCount += PAGE"
          />
          <span>
            {{ shown.length }} of {{ alerts.total }}; each row opens the explanation, rule, and
            cited change rows.
          </span>
        </span>
      </template>
    </TerminalPanel>

    <TerminalPanel
      id="ticker"
      title="Ticker"
      note="Single role adds and closes, retitles, location changes."
    >
      <template v-if="ticker">
        <TerminalGap
          v-if="ticker.rows.length === 0"
          title="Nothing on the ticker."
          reason="An empty ticker is normal."
        />
        <!-- A feed, so a scroll region: nobody reads line 157, and the page
             should not be 157 lines tall so that they can. tabindex="0" so
             a keyboard can scroll it (axe: scrollable-region-focusable). -->
        <div
          v-else
          class="max-h-96 overflow-y-auto"
          tabindex="0"
          role="region"
          aria-label="Ticker lines"
        >
          <TerminalTickerList :alerts="ticker.rows" />
        </div>
      </template>
      <template v-if="ticker?.rows.length" #meta>
        {{ ticker.rows.length }} of {{ ticker.total }}
      </template>
    </TerminalPanel>
  </TerminalPage>
</template>
