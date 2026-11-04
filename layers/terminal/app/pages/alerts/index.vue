<script setup lang="ts">
// Every alert, newest first, split by materiality: the alerts (notable,
// critical) lead, the minor changes (info) follow as one line each. Each
// headline is a permalink to the alert with its cited rows in full. The Atom
// feed at /alerts.xml carries the alerts; ?include=info adds the minor changes.

import { INFO_FEED_QUERY, INFO_TIER_LABEL } from '../../../shared/utils/terminal-tiers'
import type { AlertsData } from '../../../shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.9',
    title: 'Alerts',
    summary:
      'Alerts raised on the change log, split by materiality: notable and critical alerts, then the minor changes (severity info). Each cites its change rows and source. Atom at /alerts.xml (add ?include=info for the minor changes).',
  },
})

const [{ data: alerts, error: alertsError }, { data: minor, error: minorError }] =
  await Promise.all([
    useFetch<AlertsData>('/api/alerts', { query: { tier: 'alert' } }),
    useFetch<AlertsData>('/api/alerts', { query: { tier: 'info' } }),
  ])

useSeo({
  title: 'AI lab pricing, hiring, and filing alerts',
  description:
    'Every alert raised on pricing, hiring, and SEC changes at the frontier AI labs, split into alerts and minor changes, each citing its change rows and sources.',
  dateModified: alerts.value?.as_of,
})

const failed = computed(() => Boolean(alertsError.value || minorError.value))

// The page holds every alert the endpoint returned; the reader sees a page
// of rows at a time. "Show more" rather than a scroll region: a long list
// stays in the document, where find-in-page and a crawler can reach it.
const PAGE = 25
const shownCount = ref(PAGE)
const shown = computed(() => alerts.value?.rows.slice(0, shownCount.value) ?? [])
const remaining = computed(() => (alerts.value?.rows.length ?? 0) - shown.value.length)
// The minor changes page the same way: a scroll box inside a scrolling page hid
// its rows from find-in-page and made the page scroll twice.
const minorCount = ref(PAGE)
const minorShown = computed(() => minor.value?.rows.slice(0, minorCount.value) ?? [])
const minorRemaining = computed(() => (minor.value?.rows.length ?? 0) - minorShown.value.length)
const infoFeed = `/alerts.xml?${INFO_FEED_QUERY}`
</script>

<template>
  <TerminalPage
    title="Alerts"
    lede="Alerts are material changes: a price move, a new SKU, a hiring shift, a filing. Minor changes are listed below them. Each cites the change rows it rests on."
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
          :to="infoFeed"
          external
          class="font-mono text-primary underline underline-offset-2"
          >?{{ INFO_FEED_QUERY }}</NuxtLink
        >
        adds the minor changes.
      </p>
    </template>

    <!-- Side by side only where the alert table keeps its headline column
         readable at two-thirds of the container. -->
    <div class="grid items-start gap-6 2xl:grid-cols-3">
      <TerminalPanel
        id="alerts"
        class="2xl:col-span-2"
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
          <TerminalSignalTable v-else :alerts="shown" flow />
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
        id="minor-changes"
        :title="INFO_TIER_LABEL"
        note="Single role adds and closes, retitles, location changes."
      >
        <template v-if="minor">
          <TerminalGap
            v-if="minor.rows.length === 0"
            title="No minor changes."
            reason="An empty list here is normal."
          />
          <TerminalTickerList v-else :alerts="minorShown" />
        </template>
        <template v-if="minor?.rows.length" #meta>
          {{ minor.rows.length }} of {{ minor.total }}
        </template>
        <template v-if="minorRemaining > 0" #foot>
          <UButton
            variant="link"
            size="sm"
            class="px-0"
            :label="`Show ${Math.min(PAGE, minorRemaining)} more`"
            @click="minorCount += PAGE"
          />
        </template>
      </TerminalPanel>
    </div>
  </TerminalPage>
</template>
