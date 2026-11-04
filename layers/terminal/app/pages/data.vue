<script setup lang="ts">
// What the store holds and how to take it away: one row per exportable
// table with its columns, its current row count, and CSV/JSON downloads,
// then the data dictionary that documents every column of them.

import {
  DATA_LICENSE,
  HISTORY_LICENSE,
  HISTORY_PARAM,
  LICENSE_SPLIT_EFFECTIVE,
  LICENSE_WINDOW_DAYS,
} from '#shared/utils/license'
import { mailto } from '../../shared/utils/contact'
import { count } from '../../shared/utils/terminal-format'
import { INFO_FEED_QUERY } from '../../shared/utils/terminal-tiers'
import type { CoverageData, DataDictionary, SourceAxis } from '../../shared/utils/terminal-types'
import type { TableColumn } from '../types/terminal-ui'

definePageMeta({
  publicPage: {
    changefreq: 'weekly',
    priority: '0.6',
    title: 'Data',
    summary:
      'Every source we read, with its last check and caveat. CSV or JSON downloads of every table (prices, open jobs, incidents, SEC facts, changes, and alerts), each row with its source URL. Tables that grow over time download the last 90 days (CC BY 4.0) by default, and the full history (CC BY-NC 4.0) on request. A data dictionary gives each column’s type, unit, and meaning.',
  },
})

const [{ data: coverage, error }, { data: dictionary }] = await Promise.all([
  useFetch<CoverageData>('/api/coverage'),
  useFetch<DataDictionary>('/export/dictionary.json'),
])

/** Tables whose dictionary section is open; a download row's Columns link adds its table. */
const openTables = ref<string[]>([])

const refusesAsOf = computed(() =>
  (dictionary.value?.tables ?? []).filter((t) => t.as_of.mode === 'refused').map((t) => t.name),
)

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
//
// isBasedOn credits the upstream sources a table is read from, by axis; the
// tables that span every source (snapshots, changes, alerts) credit none
// rather than all forty.
const TABLE_AXES: Record<string, readonly SourceAxis[]> = {
  prices_latest: ['pricing-catalog', 'pricing-cross-check'],
  jobs_open: ['hiring'],
  incidents: ['status'],
  disclosures: ['disclosures'],
  disclosure_timelines: ['disclosures'],
  filers: ['sec'],
  revenue_facts: ['sec', 'revenue'],
}
const basedOn = (table: string): string[] => {
  const axes = TABLE_AXES[table]
  const urls =
    table === 'recipe_observations'
      ? (coverage.value?.recipes ?? []).map((r) => r.url)
      : axes
        ? (coverage.value?.sources ?? [])
            .filter((s) => !s.derived_from && axes.includes(s.axis))
            .map((s) => s.url)
        : []
  return [...new Set(urls)]
}
const temporalCoverage = openTemporalCoverage(coverage.value?.first_fetched_at)

const datasets = (coverage.value?.exports ?? []).map((table) =>
  datasetSchema(site, {
    url: pageUrl,
    slug: table.name,
    name: `${table.name} (${site.appName})`,
    description: table.description,
    dateModified: coverage.value?.as_of,
    variableMeasured: table.columns,
    rows: table.rows,
    temporalCoverage,
    isBasedOn: basedOn(table.name),
    distribution: [
      { encodingFormat: 'text/csv', contentUrl: `${site.appUrl}/export/${table.name}.csv` },
      {
        encodingFormat: 'application/json',
        contentUrl: `${site.appUrl}/export/${table.name}.json`,
      },
      // The full history is its own download under its own license.
      ...(table.history === 'windowed'
        ? [
            {
              encodingFormat: 'text/csv',
              contentUrl: `${site.appUrl}/export/${table.name}.csv?${HISTORY_PARAM}=full`,
              license: HISTORY_LICENSE.url,
            },
          ]
        : []),
    ],
  }),
)

useSeo({
  title: 'Data',
  description:
    'Every table as CSV or JSON, each row with its source URL, and a dictionary of every column. The last 90 days are CC BY 4.0. The full history is CC BY-NC 4.0.',
  dateModified: coverage.value?.as_of,
  schema: [
    dataCatalogSchema(site, {
      description:
        'Every table behind the terminal as a CSV or JSON download. Tables that grow over time download the last 90 days by default (CC BY 4.0) and the full history on request (CC BY-NC 4.0). Each row has the URL we read it from and when.',
      dateModified: coverage.value?.as_of,
    }),
    ...datasets,
  ],
})

const EXPORT_COLUMNS: TableColumn[] = [
  { key: 'name', label: 'Table' },
  { key: 'rows', label: 'Rows', numeric: true },
  { key: 'columns', label: 'Columns', class: 'font-mono text-xs text-muted' },
  { key: 'download', label: 'Download' },
]
</script>

<template>
  <TerminalPage
    title="Data"
    lede="Every source we read, and every table we hold as a CSV or JSON download. Each row has its source URL and the time we fetched it."
    :as-of="coverage?.as_of"
    :error="Boolean(error)"
    error-title="Row counts didn’t load"
    error-body="The downloads below still work. Only the row counts are missing."
  >
    <TerminalPanel
      id="coverage"
      title="Coverage"
      note="Each source with its newest snapshot, last check, snapshot count, rows, the audit’s caveat, and the terms and robots.txt we read it under."
      flush
    >
      <TerminalCoveragePanel v-if="coverage" :coverage="coverage" />
      <template #foot>
        Each label links to the URL we fetched. Hover over an age for the full UTC timestamp.
      </template>
    </TerminalPanel>

    <TerminalPanel
      id="tables"
      title="Tables"
      :note="`Tables that grow over time download the last ${LICENSE_WINDOW_DAYS} days. Full history has every row, each with its license. Every row has its source URL and fetch time.`"
      flush
    >
      <TerminalTable
        caption="Exportable tables with row counts and download links"
        :columns="EXPORT_COLUMNS"
        :rows="coverage?.exports ?? []"
        :row-key="(t) => t.name"
        align="top"
      >
        <template #cell-name="{ row: t }">
          <span class="font-mono text-highlighted">{{ t.name }}</span>
          <span class="block max-w-md text-xs text-muted">{{ t.description }}</span>
        </template>
        <template #cell-rows="{ row: t }">{{ count(t.rows) }}</template>
        <template #cell-columns="{ row: t }">{{ t.columns.join(', ') }}</template>
        <template #cell-download="{ row: t }">
          <span class="flex flex-wrap gap-2">
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
            <UButton
              v-if="t.history === 'windowed'"
              :to="`/export/${t.name}.csv?${HISTORY_PARAM}=full`"
              external
              size="sm"
              variant="link"
              color="neutral"
              :aria-label="`Full history of ${t.name}, CSV, licensed ${HISTORY_LICENSE.short}`"
              label="Full history"
            />
            <UButton
              :to="`/export/sample/${t.name}.csv`"
              external
              size="sm"
              variant="link"
              color="neutral"
              :aria-label="`Sample of ${t.name}, CSV`"
              label="Sample"
            />
            <UButton
              :to="`#dictionary-${t.name}`"
              size="sm"
              variant="link"
              color="neutral"
              :aria-label="`Column dictionary for ${t.name}`"
              label="Columns"
              @click="openTables = [...new Set([...openTables, t.name])]"
            />
          </span>
        </template>
      </TerminalTable>
      <template v-if="coverage" #foot>
        Data as of the last check<template v-if="coverage.as_of"
          >, <time :datetime="coverage.as_of">{{ coverage.as_of }}</time></template
        ><span v-else> (none has run yet)</span>. Exports are live. The counts above can be up to
        five minutes old, and count every row, not just the last {{ LICENSE_WINDOW_DAYS }} days.
        Each sample is the first 50 rows of the default download in export order (oldest first when
        the table is ordered by time), at
        <span class="font-mono">/export/sample/&lt;table&gt;.csv</span> or
        <span class="font-mono">.json</span>. <span class="font-mono">entity_securities</span> maps
        each lab and tracked company to its issuer, CIK, and ticker symbol, and says so when a lab
        is private. We no longer export <span class="font-mono">rankings_daily</span>. OpenRouter
        licenses its rankings CC BY 4.0 but says they aren’t to be re-served as a competing free
        API. So the per-lab shares stay on
        <NuxtLink to="/rankings" class="text-primary underline underline-offset-2"
          >/rankings</NuxtLink
        >
        and the raw rows stay with OpenRouter.
      </template>
    </TerminalPanel>

    <TerminalPanel
      id="dictionary"
      title="Data dictionary"
      note="Every exported column: type, unit, whether it can be null, whether it is a key, and what it holds."
    >
      <TerminalDictionary v-if="dictionary" v-model:open="openTables" :dictionary="dictionary" />
      <TerminalGap
        v-else
        title="Dictionary unavailable"
        reason="We couldn’t read the column dictionary. The downloads above still work."
      />
      <template #foot>
        Machine-readable at
        <NuxtLink
          to="/export/dictionary.json"
          external
          class="font-mono text-primary underline underline-offset-2"
          >/export/dictionary.json</NuxtLink
        >
        and
        <NuxtLink
          to="/export/dictionary.csv"
          external
          class="font-mono text-primary underline underline-offset-2"
          >/export/dictionary.csv</NuxtLink
        >, one row per table and column.
      </template>
    </TerminalPanel>

    <TerminalPanel
      id="point-in-time"
      title="Point in time"
      note="What we knew at a given moment, for a backtest."
    >
      <div class="flex max-w-3xl flex-col gap-3 text-sm text-default">
        <p>
          Add <code class="font-mono text-highlighted">?as_of=</code> with an ISO-8601 timestamp and
          a timezone, such as
          <NuxtLink
            to="/api/prices?as_of=2026-10-01T00:00:00Z"
            external
            class="font-mono text-primary underline underline-offset-2"
            >/api/prices?as_of=2026-10-01T00:00:00Z</NuxtLink
          >. You get what we held at that moment. A row counts from when we fetched it. A judged
          alert counts from when the model could have written it, not from the event it describes.
        </p>
        <ul class="flex list-disc flex-col gap-1 pl-5">
          <li>
            <span class="font-mono">/api/alerts</span>, <span class="font-mono">/api/prices</span>,
            <span class="font-mono">/api/prices/&lt;key&gt;</span>,
            <span class="font-mono">/api/hiring</span>,
            <span class="font-mono">/api/hiring/history</span> and
            <span class="font-mono">/api/revenue</span> rebuild their response and add a
            <span class="font-mono">point_in_time</span> field. It says how the answer was rebuilt
            and lists any keys the change log can’t confirm.
          </li>
          <li>
            Every table above except
            <template v-for="(name, i) in refusesAsOf" :key="name"
              ><span class="font-mono">{{ name }}</span
              >{{ i < refusesAsOf.length - 1 ? ', ' : '' }}</template
            >. Tables that only grow are cut at that moment. Tables of current rows are rebuilt from
            the change log and gain an <span class="font-mono">as_of_verified</span> column. The
            data dictionary gives each table’s rule, or why it answers 400.
          </li>
          <li>
            The MCP tools for those routes take an <span class="font-mono">as_of</span> argument.
          </li>
        </ul>
        <p class="text-muted">
          Any other route returns a 400 instead of today’s data under an earlier date.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel id="commercial" title="Commercial use">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p class="max-w-2xl text-sm text-default">
          Using the full history in a product, a fund process, or anything else commercial? That
          needs a paid license. So do signed terms, a feed you can depend on, and coverage we don’t
          have yet.
          <NuxtLink to="/contact" class="text-primary underline underline-offset-2"
            >Write to us</NuxtLink
          >. Upstream CC BY data keeps its own terms, and some sources aren’t in any paid offer.
        </p>
        <UButton
          :to="mailto('Data licensing')"
          external
          icon="i-lucide-mail"
          label="Email us"
          class="self-start sm:self-auto"
        />
      </div>
    </TerminalPanel>

    <div class="grid gap-6 lg:grid-cols-2">
      <TerminalPanel id="license" title="Terms">
        <p class="max-w-2xl text-sm text-default">
          The last {{ LICENSE_WINDOW_DAYS }} days are {{ DATA_LICENSE.short }}. Older rows are
          {{ HISTORY_LICENSE.short }}, except what we published before
          {{ LICENSE_SPLIT_EFFECTIVE }}, which stays {{ DATA_LICENSE.short }}. A full-history
          download labels each row in a <span class="font-mono">license</span> column. The
          underlying facts belong to their publishers.
          <NuxtLink to="/license" class="text-primary underline underline-offset-2"
            >Full terms and the attribution line</NuxtLink
          >.
        </p>
      </TerminalPanel>

      <TerminalPanel id="feed" title="Feed">
        <p class="text-sm text-default">
          Alerts as an Atom feed at
          <NuxtLink to="/alerts.xml" external class="text-primary underline underline-offset-2">
            /alerts.xml</NuxtLink
          >. Add
          <NuxtLink
            :to="`/alerts.xml?${INFO_FEED_QUERY}`"
            external
            class="font-mono text-primary underline underline-offset-2"
            >?{{ INFO_FEED_QUERY }}</NuxtLink
          >
          for the minor changes.
        </p>
      </TerminalPanel>
    </div>
  </TerminalPage>
</template>
