<script setup lang="ts">
// What the store holds and how to take it away: one row per exportable
// table with its columns, its current row count, and CSV/JSON downloads.

import { DATA_LICENSE } from '#shared/utils/license'
import { count } from '#shared/utils/terminal-format'
import type { CoverageData } from '#shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'weekly',
    priority: '0.6',
    title: 'Data',
    summary:
      'Bulk downloads of every table — snapshots, current prices, open jobs, status-page incidents, the change log, alerts, poll runs — as CSV or JSON, with provenance columns on every row.',
  },
})

const { data: coverage, error } = await useFetch<CoverageData>('/api/coverage')

const pageUrl = usePageUrl()
const site = useSiteContext()

// This page is the site's data catalog, so it says so in the graph: one
// DataCatalog node and one Dataset per exportable table, each with the CSV and
// JSON downloads as real DataDownload URLs.
//
// Dataset is the only schema.org type with a search index of its own rather
// than a rich-result treatment, and it is the type this site actually is. The
// nodes are built from the same `coverage.exports` the table below renders —
// if a table stops being listed it stops being described, which is the only
// way to keep the graph from claiming a download that 404s.
const datasets = (coverage.value?.exports ?? []).map((table) =>
  datasetSchema(site, {
    url: pageUrl,
    slug: table.name,
    name: `${site.appName} — ${table.name}`,
    description: table.description,
    dateModified: coverage.value?.as_of,
    variableMeasured: table.columns,
    rows: table.rows,
    distribution: [
      { encodingFormat: 'text/csv', contentUrl: `${site.appUrl}/export/${table.name}.csv` },
      {
        encodingFormat: 'application/json',
        contentUrl: `${site.appUrl}/export/${table.name}.json`,
      },
    ],
  }),
)

useSeo({
  title: 'Data',
  description:
    'Download the terminal’s tables as CSV or JSON: snapshots, prices, open jobs, incidents, the change log, alerts and poll runs, each row with its source URL.',
  dateModified: coverage.value?.as_of,
  schema: [
    dataCatalogSchema(site, {
      description:
        'Every table behind the terminal, streamed whole as CSV or JSON. Each row carries the URL it was read from and when.',
      dateModified: coverage.value?.as_of,
    }),
    ...datasets,
  ],
})
</script>

<template>
  <div class="space-y-8">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">Data</h1>
      <p class="max-w-2xl text-muted">
        Every table, as it stands, streamed whole. Each row carries the URL it was read from and
        when; <code class="text-default">source_runs</code> is the one table without a
        <code class="text-default">fetched_at</code>, because a failed run fetched nothing and a
        timestamp claiming otherwise would be the lie the provenance rule exists to prevent.
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Table counts could not be read"
      description="The downloads below still work; only the row counts are unavailable."
    />

    <TerminalPanel id="tables" title="Tables">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <caption class="sr-only">
            Exportable tables with row counts and download links
          </caption>
          <thead>
            <tr class="border-b border-default text-left">
              <th scope="col" class="py-2 pr-4 font-medium text-muted">Table</th>
              <th scope="col" class="py-2 pr-4 text-right font-medium text-muted">Rows</th>
              <th scope="col" class="py-2 pr-4 font-medium text-muted">Columns</th>
              <th scope="col" class="py-2 font-medium text-muted">Download</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="t in coverage?.exports ?? []"
              :key="t.name"
              class="border-b border-default align-top"
            >
              <th scope="row" class="py-3 pr-4 text-left font-normal">
                <span class="font-mono text-highlighted">{{ t.name }}</span>
                <span class="block max-w-md text-xs text-muted">{{ t.description }}</span>
              </th>
              <td class="py-3 pr-4 text-right font-mono">{{ count(t.rows) }}</td>
              <td class="py-3 pr-4 font-mono text-xs text-muted">{{ t.columns.join(', ') }}</td>
              <td class="py-3">
                <div class="flex gap-2">
                  <UButton
                    :to="`/export/${t.name}.csv`"
                    external
                    size="sm"
                    variant="outline"
                    color="neutral"
                    icon="i-lucide-download"
                    label="CSV"
                  />
                  <UButton
                    :to="`/export/${t.name}.json`"
                    external
                    size="sm"
                    variant="outline"
                    color="neutral"
                    icon="i-lucide-braces"
                    label="JSON"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="coverage" class="text-xs text-muted">
        Data as of poll tick
        <time v-if="coverage.as_of" :datetime="coverage.as_of">{{ coverage.as_of }}</time>
        <span v-else>— no poll has run yet</span>. Exports are served live; the counts above are
        cached for up to five minutes.
      </p>
    </TerminalPanel>

    <TerminalPanel id="license" title="Terms">
      <p class="max-w-2xl text-sm text-default">
        The compilation — these tables, the change log and the alerts — is licensed
        {{ DATA_LICENSE.short }}. The underlying facts belong to whoever published them, which is
        why every row carries its source URL.
        <NuxtLink to="/license" class="text-primary underline underline-offset-2"
          >Full terms and the attribution line</NuxtLink
        >.
      </p>
    </TerminalPanel>

    <TerminalPanel id="feed" title="Feed">
      <p class="text-sm text-default">
        Alerts are also published as Atom at
        <NuxtLink to="/alerts.xml" external class="text-primary underline underline-offset-2">
          /alerts.xml</NuxtLink
        >: one entry per alert linking to its permalink, its explanation as the summary, and the
        source URL as a related link. The feed carries the alert tier (notable, critical);
        <NuxtLink
          to="/alerts.xml?include=ticker"
          external
          class="font-mono text-primary underline underline-offset-2"
          >/alerts.xml?include=ticker</NuxtLink
        >
        adds the info-tier ticker.
      </p>
    </TerminalPanel>
  </div>
</template>
