<script setup lang="ts">
// Every status-page incident in the last 90 days, newest first, each linked
// to the vendor's own incident page and stamped with the fetch it was read
// from, under the per-lab summary the overview leads with.

import { absoluteStamp } from '../../shared/utils/terminal-format'
import { labName } from '../../shared/utils/terminal-labs'
import type { IncidentView, IncidentsData } from '../../shared/utils/terminal-types'
import type { LimitsData } from '../../shared/utils/recipe-views'
import type { TableColumn } from '../types/terminal-ui'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Incidents',
    summary:
      'Status-page incidents posted by OpenAI, Anthropic, and Google (Gemini / Vertex AI only) over the last 90 days. Each shows impact, status, components, start, and resolution, linked to the vendor’s incident page.',
  },
})

const [{ data: incidents, error }, { data: limits }] = await Promise.all([
  useFetch<IncidentsData>('/api/incidents'),
  useFetch<LimitsData>('/api/limits'),
])

const site = useSiteContext()

useSeo({
  title: 'AI API outages and status incidents',
  description:
    'Status-page incidents at the frontier AI labs over the last 90 days, as each vendor posted them, with source feed and fetch time on every row.',
  dateModified: incidents.value?.as_of,
  schema: [
    datasetSchema(site, {
      url: usePageUrl(),
      name: 'Frontier AI lab status-page incidents',
      description:
        'Every incident the frontier AI labs posted to their own status pages: title, impact and status verbatim (impact left blank where a feed publishes none), start and resolution times, and affected components.',
      dateModified: incidents.value?.as_of,
      variableMeasured: ['impact', 'status', 'started_at', 'resolved_at', 'components'],
      distribution: exportDistribution(site, 'incidents'),
    }),
  ],
})

const now = useNow()

/** Minutes between start and resolution, as printed by the feed; null while open. */
const durationLabel = (i: IncidentView): string | null => {
  if (i.resolved_at === null) return null
  const minutes = Math.round((Date.parse(i.resolved_at) - Date.parse(i.started_at)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 0) return null
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const columns: TableColumn[] = [
  { key: 'started', label: 'Started', class: 'whitespace-nowrap font-mono text-xs' },
  { key: 'provider', label: 'Lab', class: 'whitespace-nowrap' },
  { key: 'title', label: 'Incident' },
  { key: 'impact', label: 'Impact', class: 'font-mono text-xs' },
  { key: 'status', label: 'Status' },
  { key: 'duration', label: 'Duration', numeric: true, class: 'text-xs' },
  { key: 'source', label: 'Read from' },
]
</script>

<template>
  <TerminalPage
    title="Incidents"
    lede="Every status-page incident, in the vendor’s own words, linked to the incident page it was read from."
    :as-of="incidents?.as_of"
    :error="Boolean(error)"
    error-title="Incidents didn’t load"
    error-body="Try reloading in a minute."
  >
    <template v-if="incidents">
      <div class="grid gap-6" :class="limits?.pages.length ? 'xl:grid-cols-2' : undefined">
        <TerminalPanel
          id="labs"
          title="By lab"
          :note="`The last ${incidents.window_days} days against the ${incidents.window_days} before. A count is what the vendor chose to post, not an SLA.`"
          flush
        >
          <TerminalStrainTable :incidents="incidents" />
          <template #foot>
            Counted by the vendor’s posted start time, going back from
            <time :datetime="incidents.window_to" :title="incidents.window_to">{{
              absoluteStamp(incidents.window_to, now)
            }}</time
            >. Impact and status are in each vendor’s own words.
          </template>
        </TerminalPanel>

        <TerminalPanel
          v-if="limits?.pages.length"
          id="limits"
          title="Published rate limits"
          note="The limits each lab publishes, and when one last changed. Each lab’s page has the full table."
        >
          <TerminalLimitsSummary :limits="limits" />
        </TerminalPanel>
      </div>

      <TerminalGap
        v-if="incidents.incidents.length === 0"
        title="No incidents in the window."
        :reason="`No incident started in the last ${incidents.history_days} days on any feed we check.`"
        :action="{ label: 'Coverage', to: '/data#coverage' }"
      />

      <TerminalPanel
        v-else
        id="incidents"
        :title="`Last ${incidents.history_days} days`"
        :note="`${incidents.incidents.length} incidents, newest first, to ${absoluteStamp(incidents.window_to, now)}.`"
        flush
      >
        <TerminalTable
          :caption="`Status-page incidents in the last ${incidents.history_days} days, newest first`"
          :columns="columns"
          :rows="incidents.incidents"
          :row-key="(i) => i.entity_key"
          row-header="title"
          align="top"
          flow
        >
          <template #cell-started="{ row: i }">
            <time :datetime="i.started_at" :title="i.started_at">
              {{ absoluteStamp(i.started_at, now) }}
            </time>
          </template>
          <template #cell-provider="{ row: i }">{{ labName(i.provider) }}</template>
          <template #cell-title="{ row: i }">
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
          </template>
          <template #cell-impact="{ row: i }">
            <span v-if="i.impact === null" class="font-sans text-muted">not published</span>
            <template v-else>{{ i.impact }}</template>
          </template>
          <template #cell-status="{ row: i }">
            <UBadge
              v-if="i.resolved_at === null"
              color="warning"
              variant="subtle"
              size="sm"
              icon="i-lucide-activity"
            >
              open · {{ i.status }}
            </UBadge>
            <span v-else class="font-mono text-xs text-muted">{{ i.status }}</span>
          </template>
          <template #cell-duration="{ row: i }">{{ durationLabel(i) ?? '—' }}</template>
          <template #cell-source="{ row: i }">
            <TerminalProvenanceTag :source-url="i.source_url" :fetched-at="i.fetched_at" />
          </template>
        </TerminalTable>
        <template #foot>
          Duration is resolution minus start, as the feed states them. Anthropic’s feed states them
          to the minute and publishes no impact, so its impact reads “not published”.
        </template>
      </TerminalPanel>
    </template>
  </TerminalPage>
</template>
