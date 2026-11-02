<script setup lang="ts">
// Every entry on each lab's own misalignment-disclosure index, in the lab's
// words, with the discovery and publication dates printed on each report's
// page and the days between them. Only OpenAI publishes an index; the other
// labs are rows that say so. The landing page's Disclosures panel is the
// summary of this.

import { labName } from '#shared/utils/terminal-labs'
import type { DisclosureView, DisclosuresData } from '#shared/utils/terminal-types'
import type { TableColumn } from '~/types/terminal-ui'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.7',
    title: 'Disclosures',
    summary:
      'Misalignment reports and notices the frontier labs publish about their own models — agents leaving their sandbox, messaging through public services, deceiving in their summaries — with the days from discovery to publication. Only OpenAI publishes an index.',
  },
})

const { data: disclosures, error } = await useFetch<DisclosuresData>('/api/disclosures')

const site = useSiteContext()

useSeo({
  title: 'AI misalignment disclosures by lab',
  description:
    'Misalignment reports and notices the frontier AI labs publish, verbatim, with discovery and disclosure dates and the source and fetch time on every row.',
  dateModified: disclosures.value?.as_of,
  schema: [
    datasetSchema(site, {
      url: usePageUrl(),
      name: 'Frontier AI lab misalignment disclosures',
      description:
        'Every entry on a frontier lab’s own misalignment-disclosure index: report or notice, title, summary, model, and context verbatim, with the date the index prints. A count measures disclosure, not behavior.',
      dateModified: disclosures.value?.as_of,
      variableMeasured: ['kind', 'title', 'model', 'listed_on'],
      distribution: exportDistribution(site, 'disclosures'),
    }),
  ],
})

const reports = computed(() => disclosures.value?.entries.filter((e) => e.kind === 'report') ?? [])
const notices = computed(() => disclosures.value?.entries.filter((e) => e.kind === 'notice') ?? [])

const REPORT_COLUMNS: TableColumn[] = [
  { key: 'provider', label: 'Lab', class: 'whitespace-nowrap' },
  { key: 'title', label: 'Report', class: 'max-w-md' },
  { key: 'model', label: 'Model · observed', class: 'text-xs' },
  { key: 'discovered', label: 'Discovered', class: 'whitespace-nowrap font-mono text-xs' },
  { key: 'disclosed', label: 'Disclosed', class: 'whitespace-nowrap font-mono text-xs' },
  { key: 'days', label: 'Days', numeric: true, class: 'text-xs text-highlighted' },
  { key: 'source', label: 'Read from', keep: true },
]

const NOTICE_COLUMNS: TableColumn[] = [
  { key: 'listed_on', label: 'Listed', class: 'whitespace-nowrap font-mono text-xs text-muted' },
  { key: 'provider', label: 'Lab', class: 'whitespace-nowrap' },
  { key: 'title', label: 'Notice' },
  { key: 'source', label: 'Read from' },
]

const TIMELINE_GAP: Record<Exclude<DisclosureView['timeline_status'], 'ok'>, string> = {
  not_applicable: '—',
  not_fetched: 'report page not polled yet',
  title_mismatch: 'report page title differs; dates not attached',
}
</script>

<template>
  <TerminalPage
    title="Disclosures"
    lede="Reports and notices the labs publish about misalignment in their own models, in each lab’s words, each linked to its source page. This measures disclosure practice, not how often misalignment occurs: a lab with no index shows no entries because it publishes none."
    :as-of="disclosures?.as_of"
    :error="Boolean(error)"
    error-title="Disclosures could not be read"
    error-body="The disclosures endpoint failed to respond."
  >
    <template v-if="disclosures">
      <TerminalPanel
        id="labs"
        title="By lab"
        note="Median days from the discovery date a report prints to the date it was published."
        flush
      >
        <TerminalDisclosureTable :disclosures="disclosures" />
      </TerminalPanel>

      <TerminalGap
        v-if="disclosures.entries.length === 0"
        title="No disclosures parsed yet."
        reason="The index is registered; entries appear after its first poll."
        :action="{ label: 'Coverage', to: '/data#coverage' }"
      />

      <template v-else>
        <TerminalPanel
          id="reports"
          title="Reports"
          :note="`${reports.length} reports, newest listed first.`"
          flush
        >
          <TerminalTable
            caption="Misalignment reports, newest listed first, with discovery and disclosure dates"
            :columns="REPORT_COLUMNS"
            :rows="reports"
            :row-key="(r) => r.entity_key"
            row-header="title"
            :gap="(r) => !r.timeline"
            :gap-columns="['discovered', 'disclosed', 'days']"
            align="top"
          >
            <template #cell-provider="{ row: r }">{{ labName(r.provider) }}</template>
            <template #cell-title="{ row: r }">
              <a
                :href="r.entry_url"
                target="_blank"
                rel="noopener noreferrer"
                class="text-highlighted underline underline-offset-2"
                >{{ r.title }}</a
              >
              <span class="block text-xs text-muted">{{ r.summary }}</span>
              <span v-if="r.timeline?.lines.length" class="block text-xs text-muted">
                {{ r.timeline.lines.map((l) => `${l.label}: ${l.value}`).join(' · ') }}
              </span>
            </template>
            <template #cell-model="{ row: r }">
              {{ [r.model, r.observed_during].filter(Boolean).join(' · ') || '—' }}
            </template>
            <template #cell-discovered="{ row: r }">
              {{ r.timeline!.discovered_on ?? 'not stated' }}
            </template>
            <template #cell-disclosed="{ row: r }">
              {{ r.timeline!.disclosed_on ?? '—' }}
              <TerminalCaveatMark
                v-if="r.timeline!.disclosed_basis === 'first_listed'"
                :name="`How the disclosure date of ${r.title} was read`"
                text="The report page prints no disclosure date. This is the earliest date the index has listed beside the report in any stored snapshot."
              />
            </template>
            <template #cell-days="{ row: r }">{{ r.timeline!.days_to_disclosure ?? '—' }}</template>
            <template #cell-source="{ row: r }">
              <span class="flex flex-col gap-1">
                <TerminalProvenanceTag :source-url="r.source_url" :fetched-at="r.fetched_at" />
                <TerminalProvenanceTag
                  v-if="r.timeline"
                  :source-url="r.timeline.source_url"
                  :fetched-at="r.timeline.fetched_at"
                />
              </span>
            </template>
            <template #gap="{ row: r }">
              {{ TIMELINE_GAP[r.timeline_status as keyof typeof TIMELINE_GAP] }}
            </template>
          </TerminalTable>
          <template #foot>
            Days run from the discovery date to the publication date, both as printed on the report
            page. The occurrence line (sample, incident date) is shown verbatim and not parsed as a
            date.
          </template>
        </TerminalPanel>

        <TerminalPanel
          v-if="notices.length"
          id="notices"
          title="Notices"
          note="External incidents the lab has posted about, each linked to an update on its own site."
          flush
        >
          <TerminalTable
            caption="Notices, newest listed first"
            :columns="NOTICE_COLUMNS"
            :rows="notices"
            :row-key="(n) => n.entity_key"
            row-header="title"
            align="top"
          >
            <template #cell-provider="{ row: n }">{{ labName(n.provider) }}</template>
            <template #cell-title="{ row: n }">
              <a
                :href="n.entry_url"
                target="_blank"
                rel="noopener noreferrer"
                class="text-highlighted underline underline-offset-2"
                >{{ n.title }}</a
              >
              <span class="block text-xs text-muted">{{ n.summary }}</span>
            </template>
            <template #cell-source="{ row: n }">
              <TerminalProvenanceTag :source-url="n.source_url" :fetched-at="n.fetched_at" />
            </template>
          </TerminalTable>
        </TerminalPanel>
      </template>
    </template>
  </TerminalPage>
</template>
