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
          <p class="text-sm text-muted">Showing {{ alerts.rows.length }} of {{ alerts.total }}.</p>
          <TerminalAlertList :alerts="alerts.rows" :level="3" />
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
          <TerminalTickerList :alerts="ticker.rows" />
        </template>
      </template>
    </TerminalPanel>
  </div>
</template>
