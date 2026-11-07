<script setup lang="ts">
// Every alert, newest first, split by materiality: the alerts (notable,
// critical) lead, the minor changes (info) follow as one line each. Each
// headline is a permalink to the alert with its cited rows in full. The Atom
// feed at /alerts.xml carries the alerts; ?include=info adds the minor changes.
//
// The filters (?lab=, ?topic=, ?tier=critical|notable) are the /api/alerts
// parameters, spelled the same, so a filtered view is a link someone can send.
// Lab and topic narrow both lists; the level narrows the alert list. "Show
// more" pages back through the whole history by cursor rather than slicing one
// fixed fetch, so nothing older than the newest page is out of reach.

import { LABS } from '../../../shared/utils/terminal-lab-summary'
import { ALERT_AXES, AXIS_DISPLAY, LAB_DISPLAY } from '../../../shared/utils/terminal-labs'
import {
  CRITICAL_FEED_QUERY,
  INFO_FEED_QUERY,
  INFO_TIER_LABEL,
} from '../../../shared/utils/terminal-tiers'
import type { AlertView, AlertsData, TrackRecordData } from '../../../shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.9',
    title: 'Alerts',
    summary:
      'Alerts on what changed at the frontier labs. Notable and critical alerts come first, then minor changes (severity info). Filter by lab, topic, and level, and page back through the full history. Each cites the changes behind it and their sources. Atom feed at /alerts.xml (add ?include=info for minor changes).',
  },
})

const PAGE = 50
const LEVELS = ['alert', 'critical', 'notable'] as const
type Level = (typeof LEVELS)[number]

const route = useRoute()
const router = useRouter()

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

const level = computed<Level>(() => pick(route.query.tier, LEVELS) ?? 'alert')
const lab = computed(() => pick(route.query.lab, LABS))
const topic = computed(() => pick(route.query.topic, ALERT_AXES))
const filtered = computed(() => Boolean(lab.value || topic.value || level.value !== 'alert'))

/** A select's "everything" value drops the parameter, so the unfiltered page keeps its plain URL. */
function filterModel(name: 'tier' | 'lab' | 'topic', current: () => string, everything: string) {
  return computed({
    get: current,
    set: (value: string) =>
      void router.replace({
        query: { ...route.query, [name]: value === everything ? undefined : value },
        hash: route.hash,
      }),
  })
}
const levelModel = filterModel('tier', () => level.value, 'alert')
const labModel = filterModel('lab', () => lab.value ?? 'all', 'all')
const topicModel = filterModel('topic', () => topic.value ?? 'all', 'all')

const levelItems = [
  { label: 'Notable and critical', value: 'alert' },
  { label: 'Critical only', value: 'critical' },
  { label: 'Notable only', value: 'notable' },
]
const labItems = [
  { label: 'All labs', value: 'all' },
  ...LABS.map((id) => ({ label: LAB_DISPLAY[id], value: id })),
]
const topicItems = [
  { label: 'All topics', value: 'all' },
  ...ALERT_AXES.map((axis) => ({ label: AXIS_DISPLAY[axis], value: axis })),
]

const alertQuery = computed(() => ({
  tier: level.value,
  lab: lab.value,
  topic: topic.value,
  limit: PAGE,
}))
const minorQuery = computed(() => ({
  tier: 'info',
  lab: lab.value,
  topic: topic.value,
  limit: PAGE,
}))

const [{ data: alerts, error: alertsError }, { data: minor, error: minorError }, { data: record }] =
  await Promise.all([
    useFetch<AlertsData>('/api/alerts', { query: alertQuery }),
    useFetch<AlertsData>('/api/alerts', { query: minorQuery }),
    useFetch<TrackRecordData>('/api/track-record'),
  ])

/**
 * The first page comes from useFetch (server-rendered, refetched when a filter
 * changes); each "Show more" appends the next, older page from its cursor.
 * "Show more" rather than a scroll region: a long list stays in the document,
 * where find-in-page and a crawler can reach it.
 */
function pager(first: Ref<AlertsData | undefined>, query: Ref<Record<string, unknown>>) {
  const older = ref<AlertView[]>([])
  const cursor = ref<string | null>(null)
  const loading = ref(false)
  const failed = ref(false)
  watch(
    first,
    (page) => {
      older.value = []
      cursor.value = page?.next_cursor ?? null
      failed.value = false
    },
    { immediate: true },
  )
  async function more() {
    if (!cursor.value || loading.value) return
    loading.value = true
    try {
      const page = await $fetch<AlertsData>('/api/alerts', {
        query: { ...query.value, cursor: cursor.value },
      })
      older.value.push(...page.rows)
      cursor.value = page.next_cursor
      failed.value = false
    } catch {
      failed.value = true
    } finally {
      loading.value = false
    }
  }
  const rows = computed(() => [...(first.value?.rows ?? []), ...older.value])
  const remaining = computed(() => Math.max((first.value?.total ?? 0) - rows.value.length, 0))
  return { rows, remaining, more, loading, failed, hasMore: computed(() => cursor.value !== null) }
}

const alertPages = pager(alerts, alertQuery)
const minorPages = pager(minor, minorQuery)
const shown = alertPages.rows
const minorShown = minorPages.rows

// Two views on the same alerts: the list, and the track record, which times
// each material alert against the first press report and the lab's own post.
const tabs = [
  { value: 'alerts', label: 'Alerts' },
  { value: 'track-record', label: 'Track record' },
]

useSeo({
  title: 'AI lab pricing, hiring, and filing alerts',
  description:
    'Every alert on pricing, hiring, and SEC changes at the frontier AI labs, split into alerts and minor changes, each citing the changes and sources behind it.',
  dateModified: alerts.value?.as_of,
})

const failed = computed(() => Boolean(alertsError.value || minorError.value))

const alertNote = computed(
  () =>
    ({
      alert: 'Notable and critical, newest first.',
      critical: 'Critical only: the ones to look at today, newest first.',
      notable: 'Notable only, newest first.',
    })[level.value],
)

const infoFeed = `/alerts.xml?${INFO_FEED_QUERY}`
const criticalFeed = `/alerts.xml?${CRITICAL_FEED_QUERY}`
</script>

<template>
  <TerminalPage
    title="Alerts"
    lede="Alerts are material changes, like a price move, a new SKU, a hiring shift, or a filing. Minor changes are listed separately. Each one cites the changes it’s based on."
    :as-of="alerts?.as_of"
    :error="failed"
    error-title="Alerts didn’t load"
    error-body="Some sections may be missing. Try reloading in a minute."
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
        adds the minor changes;
        <NuxtLink
          :to="criticalFeed"
          external
          class="font-mono text-primary underline underline-offset-2"
          >?{{ CRITICAL_FEED_QUERY }}</NuxtLink
        >
        keeps only critical alerts.
      </p>
    </template>

    <TerminalTabs :tabs="tabs">
      <template #alerts>
        <div
          role="group"
          aria-label="Filter alerts"
          class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2"
        >
          <UFormField label="Lab" class="flex items-center gap-2" :ui="{ label: 'text-sm' }">
            <USelect v-model="labModel" :items="labItems" size="sm" class="w-40" />
          </UFormField>
          <UFormField label="Topic" class="flex items-center gap-2" :ui="{ label: 'text-sm' }">
            <USelect v-model="topicModel" :items="topicItems" size="sm" class="w-36" />
          </UFormField>
          <UFormField label="Level" class="flex items-center gap-2" :ui="{ label: 'text-sm' }">
            <USelect v-model="levelModel" :items="levelItems" size="sm" class="w-48" />
          </UFormField>
          <UButton
            v-if="filtered"
            to="/alerts"
            variant="link"
            size="sm"
            class="px-0"
            label="Clear filters"
          />
        </div>

        <!-- Side by side only where the alert table keeps its headline column
         readable at two-thirds of the container. -->
        <div class="grid items-start gap-6 2xl:grid-cols-3">
          <TerminalPanel
            id="alerts"
            class="2xl:col-span-2"
            title="Alerts"
            :note="alertNote"
            :flush="Boolean(shown.length)"
          >
            <template v-if="alerts">
              <TerminalGap
                v-if="shown.length === 0 && filtered"
                title="No alerts match these filters."
                reason="Try another lab, topic, or level. Critical is kept for what an analyst should look at today, so it is often empty."
                :action="{ label: 'Clear filters', to: '/alerts' }"
              />
              <TerminalGap
                v-else-if="shown.length === 0"
                title="No alerts yet."
                reason="An alert needs a change big enough to matter. Right after our first check, an empty list is normal."
                :action="{ label: 'Recent changes', to: '/#signal' }"
              />
              <TerminalSignalTable v-else :alerts="shown" flow />
            </template>
            <template v-if="shown.length" #foot>
              <span class="flex flex-wrap items-baseline gap-x-4">
                <UButton
                  v-if="alertPages.hasMore.value"
                  variant="link"
                  size="sm"
                  class="px-0"
                  :loading="alertPages.loading.value"
                  :label="`Show ${Math.min(PAGE, alertPages.remaining.value)} more`"
                  @click="alertPages.more"
                />
                <span>
                  {{ shown.length }} of {{ alerts?.total }}. Open a row for the explanation, the
                  rule, and the changes it cites.
                </span>
                <span v-if="alertPages.failed.value" role="alert" class="text-error">
                  Older alerts didn’t load. Try again.
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
                v-if="minorShown.length === 0"
                :title="filtered ? 'No minor changes match.' : 'No minor changes.'"
                reason="An empty list here is normal."
              />
              <TerminalTickerList v-else :alerts="minorShown" />
            </template>
            <template v-if="minorShown.length" #meta>
              {{ minorShown.length }} of {{ minor?.total }}
            </template>
            <template v-if="minorPages.hasMore.value || minorPages.failed.value" #foot>
              <UButton
                v-if="minorPages.hasMore.value"
                variant="link"
                size="sm"
                class="px-0"
                :loading="minorPages.loading.value"
                :label="`Show ${Math.min(PAGE, minorPages.remaining.value)} more`"
                @click="minorPages.more"
              />
              <span v-if="minorPages.failed.value" role="alert" class="text-error">
                Older changes didn’t load. Try again.
              </span>
            </template>
          </TerminalPanel>
        </div>
      </template>
      <template #track-record>
        <TerminalTrackRecord v-if="record" :record="record" />
        <TerminalGap
          v-else
          title="The track record didn’t load."
          reason="Try reloading in a minute."
        />
      </template>
    </TerminalTabs>
  </TerminalPage>
</template>
