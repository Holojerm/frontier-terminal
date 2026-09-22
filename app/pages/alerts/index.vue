<script setup lang="ts">
// Every alert, newest first, split by materiality: the alerts (notable,
// critical) lead, the ticker (info) follows as one line each. Each headline
// is a permalink to the alert with its cited rows in full. The Atom feed at
// /alerts.xml carries the alerts; ?include=ticker adds the ticker.

import { TICKER_FEED_QUERY } from '#shared/utils/terminal-tiers'
import type { AlertsData } from '#shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.9',
    title: 'Alerts',
    summary:
      'Alerts fired over the change log, split by materiality: notable and critical alerts, then the info-tier ticker. Each cites its change rows and source. Atom at /alerts.xml (add ?include=ticker for the ticker).',
  },
})

const [{ data: alerts, error: alertsError }, { data: ticker, error: tickerError }] =
  await Promise.all([
    useFetch<AlertsData>('/api/alerts', { query: { tier: 'alert' } }),
    useFetch<AlertsData>('/api/alerts', { query: { tier: 'ticker' } }),
  ])

useSeo({
  title: 'Alerts',
  description:
    'Every alert fired over pricing, hiring and SEC changes at the frontier AI labs, split into alerts and a ticker, each citing its change rows and sources.',
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
  <div class="space-y-12">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">Alerts</h1>
      <p class="max-w-2xl text-muted">
        Alerts are what an analyst should read: a price move, a new SKU, a hiring shift, a filing.
        The ticker is low-stakes movement. Each cites the change rows it rests on.
      </p>
      <p class="max-w-2xl text-sm text-muted">
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
    </header>

    <UAlert
      v-if="failed"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Alerts could not be read"
      description="The alerts endpoint failed to respond. The section that did load is shown."
    />

    <TerminalPanel id="alerts" title="Alerts" note="Notable and critical, newest first.">
      <template v-if="alerts">
        <TerminalEmptyState
          v-if="alerts.rows.length === 0"
          title="No alerts yet."
          body="Alerts fire on change rows that clear the materiality bar. An empty list after a baseline is correct."
          :action="{ label: 'What moved anyway', to: '/#signal' }"
        />
        <template v-else>
          <TerminalSignalTable :alerts="shown" />
          <div class="flex flex-wrap items-baseline gap-x-4 text-sm">
            <UButton
              v-if="remaining > 0"
              variant="link"
              size="sm"
              class="px-0"
              :label="`Show ${Math.min(PAGE, remaining)} more`"
              @click="shownCount += PAGE"
            />
            <span class="text-xs text-muted">
              {{ shown.length }} of {{ alerts.total }}; each row opens the explanation, rule and
              cited change rows.
            </span>
          </div>
        </template>
      </template>
    </TerminalPanel>

    <TerminalPanel
      id="ticker"
      title="Ticker"
      note="Single role adds and closes, retitles, location changes."
    >
      <template v-if="ticker">
        <TerminalEmptyState
          v-if="ticker.rows.length === 0"
          title="Nothing on the ticker."
          body="Silence here is an ordinary hour."
        />
        <template v-else>
          <p class="text-sm text-muted">Showing {{ ticker.rows.length }} of {{ ticker.total }}.</p>
          <!-- A feed, so a scroll region: nobody reads line 157, and the page
               should not be 157 lines tall so that they can. tabindex="0" so
               a keyboard can scroll it (axe: scrollable-region-focusable). -->
          <div
            class="max-h-96 overflow-y-auto rounded border border-default p-3"
            tabindex="0"
            role="region"
            aria-label="Ticker lines"
          >
            <TerminalTickerList :alerts="ticker.rows" />
          </div>
        </template>
      </template>
    </TerminalPanel>
  </div>
</template>
