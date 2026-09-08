<script setup lang="ts">
// Every alert, newest first, each expandable to the change rows it cites.
// The Atom feed at /alerts.xml carries the same list.

import type { AlertsData } from '#shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.9',
    title: 'Alerts',
    summary:
      'Alerts fired over the change log — the deterministic S-1 floor rule and the judged ones — each citing the change rows and the source it was read from.',
  },
})

useSeo({
  title: 'Alerts',
  description:
    'Every alert the terminal has fired over pricing, hiring and SEC changes at the frontier AI labs, with the cited change rows and their source URLs.',
})

const { data: alerts, error } = await useFetch<AlertsData>('/api/alerts')
</script>

<template>
  <div class="space-y-8">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">Alerts</h1>
      <p class="max-w-2xl text-muted">
        An alert is a claim about change rows, and it may cite nothing else. Expand one to read the
        rows it rests on. Also available as an
        <NuxtLink to="/alerts.xml" external class="text-primary underline underline-offset-2">
          Atom feed</NuxtLink
        >.
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Alerts could not be read"
      description="The alerts endpoint failed to respond."
    />

    <template v-else-if="alerts">
      <TerminalEmptyState
        v-if="alerts.rows.length === 0"
        title="No alerts yet."
        body="Alerts are emitted over real change events: the S-1 floor rule fires on a new filing by a whitelisted CIK, and the judge lane on changes it finds significant. An empty feed after a baseline is correct."
        :action="{ label: 'What moved anyway', to: '/#signal' }"
      />
      <template v-else>
        <p class="text-sm text-muted">Showing {{ alerts.rows.length }} of {{ alerts.total }}.</p>
        <TerminalAlertList :alerts="alerts.rows" :level="2" />
      </template>
    </template>
  </div>
</template>
