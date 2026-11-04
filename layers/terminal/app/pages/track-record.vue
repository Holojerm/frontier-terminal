<script setup lang="ts">
// The track record: for each notable or critical alert, when we saw the
// change against the first same-event press article and lab newsroom post.
// Leads and lags both show. A side shows a time only once the judge rated a
// candidate the same event, so an unrated alert says so instead of guessing.

import { absoluteStamp } from '../../shared/utils/terminal-format'
import { LAB_DISPLAY } from '../../shared/utils/terminal-labs'
import { alertPath } from '../../shared/utils/terminal-tiers'
import type {
  TrackRecordData,
  TrackRecordRow,
  TrackRecordTally,
} from '../../shared/utils/terminal-types'
import type { TableColumn } from '../types/terminal-ui'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.7',
    title: 'Track record',
    summary:
      'For each notable or critical alert since 2026-09-08, when we saw the change, when the press first reported it (from GDELT), and when the lab posted it on its own newsroom, with the lead or lag in hours. Misses are shown too.',
  },
})

const { data: record, error } = await useFetch<TrackRecordData>('/api/track-record')

useSeo({
  title: 'Track record: did we see it before the press?',
  description:
    'Each material alert on the frontier AI labs, timed against the first press report and the lab’s own announcement. Leads and lags, with links to all three.',
  dateModified: record.value?.as_of,
})

const now = useNow()

/** '+3.2 h' when we saw it first, '−5 h' when the press did. */
const leadLabel = (h: number) =>
  `${h > 0 ? '+' : h < 0 ? '−' : '±'}${Math.abs(h).toLocaleString('en-US', { maximumFractionDigits: 1 })} h`

const labsOf = (row: TrackRecordRow) =>
  row.providers
    .filter((p) => p !== 'other')
    .map((p) => LAB_DISPLAY[p])
    .join(', ')

const alerts = (n: number) => `${n} alert${n === 1 ? '' : 's'}`

const sameHour = (t: TrackRecordTally) =>
  t.tied ? ` ${t.tied} ${t.tied === 1 ? 'was' : 'were'} within the same hour.` : ''

const medianText = (t: TrackRecordTally) =>
  t.median_lead_hours === null ? '' : ` The median lead is ${leadLabel(t.median_lead_hours)}.`

const pressSummary = (t: TrackRecordTally) =>
  t.matched === 0
    ? 'No alert has a rated press report yet.'
    : `Of ${alerts(t.matched)} with a rated press report, we saw ${t.led} first and the press saw ${t.lagged} first.${sameHour(t)}${medianText(t)}`

const newsroomSummary = (t: TrackRecordTally) =>
  t.matched === 0
    ? 'No alert has a rated newsroom post yet.'
    : `Of ${alerts(t.matched)} with a rated newsroom post, we saw ${t.led} before the lab posted and the lab posted ${t.lagged} first.${sameHour(t)}${medianText(t)}`

const status = (r: TrackRecordData) => {
  const waiting = r.press.not_yet_rated
  const open = r.window_open
  return [
    `${alerts(r.rows.length)} rated notable or critical since ${r.from}.`,
    waiting ? `${waiting} ${waiting === 1 ? 'waits' : 'wait'} for a press rating.` : '',
    open
      ? `${open} ${open === 1 ? 'is' : 'are'} less than ${r.window_days} days old, so we haven’t searched ${open === 1 ? 'it' : 'them'} yet.`
      : '',
    'A positive lead means we saw it first.',
  ]
    .filter(Boolean)
    .join(' ')
}

const leadClass = (h: number) => (h > 0 ? 'text-success' : h < 0 ? 'text-error' : 'text-muted')

const columns: TableColumn[] = [
  { key: 'saw', label: 'We saw it', class: 'whitespace-nowrap font-mono text-xs' },
  { key: 'headline', label: 'Alert', class: 'min-w-64' },
  { key: 'press', label: 'First press', class: 'min-w-48' },
  { key: 'press_lead', label: 'Lead', numeric: true, class: 'whitespace-nowrap text-xs' },
  { key: 'newsroom', label: 'Lab newsroom', class: 'min-w-48' },
  { key: 'newsroom_lead', label: 'Lead', numeric: true, class: 'whitespace-nowrap text-xs' },
]
</script>

<template>
  <TerminalPage
    title="Track record"
    lede="When we saw each material change, against when the press and the lab itself first reported it. Leads and lags both show."
    :as-of="record?.as_of"
    :error="Boolean(error)"
    error-title="The track record didn’t load"
    error-body="Try reloading in a minute."
  >
    <template v-if="record">
      <TerminalPanel id="summary" title="Summary">
        <div class="max-w-2xl space-y-2 text-sm text-default">
          <p>{{ pressSummary(record.press) }}</p>
          <p>{{ newsroomSummary(record.newsroom) }}</p>
          <p class="text-muted">{{ status(record) }}</p>
        </div>
      </TerminalPanel>

      <TerminalGap
        v-if="record.rows.length === 0"
        title="No material alerts yet."
        :reason="`No notable or critical alert has been raised since ${record.from}.`"
        :action="{ label: 'All alerts', to: '/alerts' }"
      />

      <TerminalPanel
        v-else
        id="alerts"
        title="Alerts"
        :note="`${record.rows.length} alerts, newest first. Lead is hours from when we saw it to the report: positive when we were first.`"
        flush
      >
        <TerminalTable
          caption="Each material alert with when we saw it, the first press report, the lab’s own post, and the lead in hours"
          :columns="columns"
          :rows="record.rows"
          :row-key="(r) => r.alert_id"
          row-header="headline"
          align="top"
          flow
        >
          <template #cell-saw="{ row }">
            <a
              :href="row.saw_source_url"
              target="_blank"
              rel="noopener noreferrer"
              class="underline underline-offset-2 hover:text-primary"
            >
              <time :datetime="row.saw_at" :title="row.saw_at">{{
                absoluteStamp(row.saw_at, now)
              }}</time>
            </a>
          </template>
          <template #cell-headline="{ row }">
            <UIcon
              :name="SEVERITY_BADGE[row.severity].icon"
              :class="row.severity === 'critical' ? 'text-error' : 'text-warning'"
              class="mr-1 inline-block size-3.5 align-[-2px]"
              :aria-label="row.severity"
            />
            <NuxtLink
              :to="alertPath(row.alert_id)"
              class="text-highlighted underline decoration-1 underline-offset-2 hover:text-primary"
              >{{ row.headline }}</NuxtLink
            >
            <span v-if="labsOf(row)" class="block text-xs text-muted">{{ labsOf(row) }}</span>
          </template>
          <template #cell-press="{ row }">
            <TerminalTrackRecordSide :side="row.press" :row="row" />
          </template>
          <template #cell-press_lead="{ row }">
            <span
              v-if="row.press.lead_hours !== null"
              class="font-mono"
              :class="leadClass(row.press.lead_hours)"
              >{{ leadLabel(row.press.lead_hours) }}</span
            >
            <span v-else class="text-muted">—</span>
          </template>
          <template #cell-newsroom="{ row }">
            <TerminalTrackRecordSide :side="row.newsroom" :row="row" />
          </template>
          <template #cell-newsroom_lead="{ row }">
            <span
              v-if="row.newsroom.lead_hours !== null"
              class="font-mono"
              :class="leadClass(row.newsroom.lead_hours)"
              >{{ leadLabel(row.newsroom.lead_hours) }}</span
            >
            <span v-else class="text-muted">—</span>
          </template>
        </TerminalTable>
      </TerminalPanel>

      <TerminalPanel id="method" title="How we time it">
        <div class="max-w-2xl space-y-3 text-sm text-default">
          <p>
            “We saw it” is when we fetched the page that showed the change. When an alert cites
            several changes, we use the earliest. A removal counts from the check that found it
            gone. The alert itself can be written up to an hour later.
          </p>
          <p>
            Once {{ record.window_days }} days have passed, we search
            <a
              href="https://www.gdeltproject.org/"
              target="_blank"
              rel="noopener noreferrer"
              class="text-primary underline underline-offset-2"
              >GDELT</a
            >
            (a public index of news sites) and the lab’s own newsroom feed for
            {{ record.window_days }} days either side. The search terms come from the changes
            themselves: the model name, the department, the filer and form. A model reads every
            headline and says whether it reports the same event. We show the earliest one it says
            does. Until every earlier candidate is rated, the row says “Not yet rated”.
          </p>
          <p>
            The press time is when GDELT first saw the article, not when the outlet published it.
            GDELT doesn’t read every outlet, and paywalled wires and newsletters are thin in it. It
            searches only the last three months, and it gives us headlines but no article text, so
            each match is judged on its headline. We never fetch the articles.
          </p>
          <p>
            A report from more than {{ record.window_days }} days before we saw it isn’t searched,
            so an old story can’t show as a lag here. Anthropic and xAI publish no newsroom feed, so
            their rows show no newsroom time. Meta’s feed holds only its newest 10 posts. Mistral
            stamps its posts near noon UTC, so read those times as dates.
          </p>
          <p>
            All times are UTC. Leads are rounded to a tenth of an hour. A lead isn’t a trading
            signal, and this isn’t investment advice. It says when a public page changed against
            when someone wrote about it.
          </p>
          <p class="text-muted">
            Press data from the GDELT Project (gdeltproject.org). Every candidate and rating is in
            the
            <NuxtLink to="/data" class="text-primary underline underline-offset-2"
              >bulk exports</NuxtLink
            >
            as track_record_candidates and track_record_verdicts.
          </p>
        </div>
      </TerminalPanel>
    </template>
  </TerminalPage>
</template>
