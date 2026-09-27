<script setup lang="ts">
// Every entry on each lab's own misalignment-disclosure index, in the lab's
// words, with the discovery and publication dates printed on each report's
// page and the days between them. Only OpenAI publishes an index; the other
// labs are rows that say so. The landing page's Disclosures panel is the
// summary of this.

import type { DisclosureView, DisclosuresData } from '#shared/utils/terminal-types'

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

useSeo({
  title: 'Disclosures',
  description:
    'Misalignment reports and notices the frontier AI labs publish, verbatim, with discovery and disclosure dates and the source and fetch time on every row.',
  dateModified: disclosures.value?.as_of,
})

const PROVIDER: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
}

const reports = computed(() => disclosures.value?.entries.filter((e) => e.kind === 'report') ?? [])
const notices = computed(() => disclosures.value?.entries.filter((e) => e.kind === 'notice') ?? [])

const TIMELINE_GAP: Record<Exclude<DisclosureView['timeline_status'], 'ok'>, string> = {
  not_applicable: '—',
  not_fetched: 'report page not polled yet',
  title_mismatch: 'report page title differs; dates not attached',
}
</script>

<template>
  <div class="space-y-8">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">Disclosures</h1>
      <p class="max-w-2xl text-muted">
        What the labs publish about their own models misbehaving — reports and notices, in the lab’s
        words, each linked to the page it was read from. This measures disclosure practice, not how
        often misalignment happens: a lab without an index shows no entries because it publishes
        none.
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Disclosures could not be read"
      description="The disclosures endpoint failed to respond."
    />

    <template v-else-if="disclosures">
      <TerminalPanel
        id="labs"
        title="By lab"
        note="Median days from the discovery date a report prints to the date it was published."
      >
        <TerminalDisclosureTable :disclosures="disclosures" />
      </TerminalPanel>

      <TerminalEmptyState
        v-if="disclosures.entries.length === 0"
        title="No disclosures parsed yet."
        body="The index is registered; the first poll will fill this page."
        :action="{ label: 'Coverage', to: '/data#coverage' }"
      />

      <template v-else>
        <TerminalPanel
          id="reports"
          title="Reports"
          :note="`${reports.length} reports, newest listed first.`"
        >
          <div class="overflow-x-auto md:overflow-visible">
            <table class="w-full text-sm">
              <caption class="sr-only">
                Misalignment reports, newest listed first, with discovery and disclosure dates
              </caption>
              <thead class="bg-default md:sticky md:top-0">
                <tr class="border-b border-default text-left">
                  <th scope="col" class="py-2 pr-4 font-medium text-muted">Lab</th>
                  <th scope="col" class="py-2 pr-4 font-medium text-muted">Report</th>
                  <th scope="col" class="py-2 pr-4 font-medium text-muted">Model · observed</th>
                  <th scope="col" class="py-2 pr-4 font-medium text-muted">Discovered</th>
                  <th scope="col" class="py-2 pr-4 font-medium text-muted">Disclosed</th>
                  <th scope="col" class="py-2 pr-4 text-right font-medium text-muted">Days</th>
                  <th scope="col" class="py-2 font-medium text-muted">Read from</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="r in reports"
                  :key="r.entity_key"
                  class="border-b border-default align-top"
                >
                  <td class="py-2 pr-4">{{ PROVIDER[r.provider] ?? r.provider }}</td>
                  <th scope="row" class="max-w-md py-2 pr-4 text-left font-normal">
                    <a
                      :href="r.entry_url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-highlighted underline underline-offset-2"
                      >{{ r.title }}</a
                    >
                    <span class="block text-xs text-muted">{{ r.summary }}</span>
                    <span v-if="r.timeline?.lines.length" class="block text-xs text-toned">
                      {{ r.timeline.lines.map((l) => `${l.label}: ${l.value}`).join(' · ') }}
                    </span>
                  </th>
                  <td class="py-2 pr-4 text-xs">
                    {{ [r.model, r.observed_during].filter(Boolean).join(' · ') || '—' }}
                  </td>
                  <template v-if="r.timeline">
                    <td class="whitespace-nowrap py-2 pr-4 font-mono text-xs">
                      {{ r.timeline.discovered_on ?? 'not stated' }}
                    </td>
                    <td class="whitespace-nowrap py-2 pr-4 font-mono text-xs">
                      {{ r.timeline.disclosed_on ?? '—' }}
                      <TerminalCaveatMark
                        v-if="r.timeline.disclosed_basis === 'first_listed'"
                        :name="`How the disclosure date of ${r.title} was read`"
                        text="The report page prints no disclosure date. This is the earliest date the index has shown beside the report in every observation this terminal holds."
                      />
                    </td>
                    <td class="py-2 pr-4 text-right font-mono text-xs text-highlighted">
                      {{ r.timeline.days_to_disclosure ?? '—' }}
                    </td>
                    <td class="py-2">
                      <span class="inline-flex flex-col gap-1">
                        <TerminalProvenanceTag
                          :source-url="r.source_url"
                          :fetched-at="r.fetched_at"
                        />
                        <TerminalProvenanceTag
                          :source-url="r.timeline.source_url"
                          :fetched-at="r.timeline.fetched_at"
                        />
                      </span>
                    </td>
                  </template>
                  <template v-else>
                    <td colspan="3" class="py-2 pr-4 text-xs text-toned">
                      {{ TIMELINE_GAP[r.timeline_status as keyof typeof TIMELINE_GAP] }}
                    </td>
                    <td class="py-2">
                      <TerminalProvenanceTag
                        :source-url="r.source_url"
                        :fetched-at="r.fetched_at"
                      />
                    </td>
                  </template>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="text-xs text-muted">
            Days run from the discovery date to the publication date, both as the report page prints
            them. The occurrence line (sample, incident date) is shown verbatim and never read as a
            date.
          </p>
        </TerminalPanel>

        <TerminalPanel
          v-if="notices.length"
          id="notices"
          title="Notices"
          note="External incidents the lab has posted about; each links to an update on the lab’s own site."
        >
          <ul class="space-y-3 text-sm">
            <li v-for="n in notices" :key="n.entity_key" class="space-y-1">
              <p>
                <a
                  :href="n.entry_url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-highlighted underline underline-offset-2"
                  >{{ n.title }}</a
                >
                <span class="ml-2 font-mono text-xs text-toned">
                  {{ PROVIDER[n.provider] ?? n.provider }} · {{ n.listed_on }}
                </span>
              </p>
              <p class="text-muted">{{ n.summary }}</p>
              <TerminalProvenanceTag :source-url="n.source_url" :fetched-at="n.fetched_at" />
            </li>
          </ul>
        </TerminalPanel>
      </template>
    </template>
  </div>
</template>
