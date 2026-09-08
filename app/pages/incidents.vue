<script setup lang="ts">
// Every status-page incident in the last 90 days, newest first, each linked
// to the vendor's own incident page and stamped with the fetch it was read
// from. The landing page's Capacity strain panel is the summary of this.

import { absoluteStamp, relativeStamp } from '#shared/utils/terminal-format'
import type { IncidentView, IncidentsData } from '#shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Incidents',
    summary:
      'Status-page incidents posted by OpenAI, Anthropic and Google (Gemini / Vertex AI only) over the last 90 days — impact, status, components, start and resolution, each linked to the vendor’s incident page.',
  },
})

useSeo({
  title: 'Incidents',
  description:
    'Status-page incidents at the frontier AI labs over the last 90 days, as each vendor posted them, with source feed and fetch time on every row.',
})

const { data: incidents, error } = await useFetch<IncidentsData>('/api/incidents')

const now = useNow()

const PROVIDER: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
}

/** Minutes between start and resolution, as printed by the feed; null while open. */
const durationLabel = (i: IncidentView): string | null => {
  if (i.resolved_at === null) return null
  const minutes = Math.round((Date.parse(i.resolved_at) - Date.parse(i.started_at)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 0) return null
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const cut = computed(() => incidents.value?.providers.find((p) => p.feed === 'no_public_feed'))
const caveats = computed(
  () => incidents.value?.providers.filter((p) => p.caveat && p.feed !== 'no_public_feed') ?? [],
)
</script>

<template>
  <div class="space-y-8">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">Incidents</h1>
      <p class="max-w-2xl text-muted">
        What each lab posted on its own status page. A row is the vendor’s words — impact and status
        are not normalized across vendors — and every row links to the incident page it was read
        from. Summary by provider on the
        <NuxtLink to="/#strain" class="text-primary underline underline-offset-2"
          >Capacity strain</NuxtLink
        >
        panel.
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Incidents could not be read"
      description="The incidents endpoint failed to respond."
    />

    <template v-else-if="incidents">
      <UAlert
        v-if="cut"
        color="info"
        variant="soft"
        icon="i-lucide-eye-off"
        :title="`${cut.display}: no public feed`"
        :description="cut.reason ?? ''"
      />

      <ul v-if="caveats.length" class="space-y-1 text-sm text-muted">
        <li v-for="p in caveats" :key="p.provider">
          <TerminalCaveatMark :label="`${p.display} feed caveat`" :text="p.caveat!" />
        </li>
      </ul>

      <TerminalEmptyState
        v-if="incidents.incidents.length === 0"
        title="No incidents in the window."
        :body="`Nothing started in the last ${incidents.history_days} days across the polled feeds — or no status feed has been polled yet (see Coverage).`"
        :action="{ label: 'Coverage', to: '/#coverage' }"
      />

      <TerminalPanel
        v-else
        id="incidents"
        :title="`Last ${incidents.history_days} days`"
        :note="`${incidents.incidents.length} incidents, newest first, counted back from the newest status fetch (${absoluteStamp(incidents.window_to, now)}).`"
      >
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <caption class="sr-only">
              Status-page incidents in the last
              {{
                incidents.history_days
              }}
              days, newest first
            </caption>
            <thead>
              <tr class="border-b border-default text-left">
                <th scope="col" class="py-2 pr-4 font-medium text-muted">Started</th>
                <th scope="col" class="py-2 pr-4 font-medium text-muted">Provider</th>
                <th scope="col" class="py-2 pr-4 font-medium text-muted">Incident</th>
                <th scope="col" class="py-2 pr-4 font-medium text-muted">Impact</th>
                <th scope="col" class="py-2 pr-4 font-medium text-muted">Status</th>
                <th scope="col" class="py-2 pr-4 text-right font-medium text-muted">Duration</th>
                <th scope="col" class="py-2 font-medium text-muted">Read from</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="i in incidents.incidents"
                :key="i.entity_key"
                class="border-b border-default align-top"
              >
                <td class="whitespace-nowrap py-2 pr-4 font-mono text-xs">
                  <time :datetime="i.started_at" :title="i.started_at">
                    {{ absoluteStamp(i.started_at, now) }}
                  </time>
                </td>
                <td class="py-2 pr-4">{{ PROVIDER[i.provider] ?? i.provider }}</td>
                <th scope="row" class="py-2 pr-4 text-left font-normal">
                  <a
                    :href="i.incident_url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-highlighted underline underline-offset-2"
                    >{{ i.title }}</a
                  >
                  <span v-if="i.components.length" class="block text-xs text-muted">
                    {{ i.components.join(' · ') }}
                  </span>
                </th>
                <td class="py-2 pr-4 font-mono text-xs">{{ i.impact }}</td>
                <td class="py-2 pr-4">
                  <UBadge
                    v-if="i.resolved_at === null"
                    color="warning"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-activity"
                  >
                    open · {{ i.status }}
                  </UBadge>
                  <span v-else class="font-mono text-xs text-toned">{{ i.status }}</span>
                </td>
                <td class="py-2 pr-4 text-right font-mono text-xs">
                  {{ durationLabel(i) ?? '—' }}
                </td>
                <td class="py-2">
                  <TerminalProvenanceTag :source-url="i.source_url" :fetched-at="i.fetched_at" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="text-xs text-muted">
          Duration is resolution minus start as the feed states them. “Read from” is the feed URL
          and the fetch that produced the row; the row’s age reads
          <time :datetime="incidents.window_to">{{ relativeStamp(incidents.window_to, now) }}</time>
          at the newest.
        </p>
      </TerminalPanel>
    </template>
  </div>
</template>
