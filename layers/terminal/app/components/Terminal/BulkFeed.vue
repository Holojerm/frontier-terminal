<script setup lang="ts">
// /data's bulk feed and schema-version panels: the daily manifest, reading a
// Parquet file in place, the public rate limits, and the export schema's
// version and changelog. The limits are the numbers the server enforces
// (REQUEST_BUDGETS) and the changelog is the dictionary's, so neither can
// drift from what a client gets.

import manifest from '~~/fleet.json'

import {
  DATA_LICENSE,
  HISTORY_LICENSE,
  HISTORY_PARAM,
  LICENSE_WINDOW_DAYS,
} from '#shared/utils/license'
import { REQUEST_BUDGETS } from '#layers/core/shared/utils/institutional'
import { count } from '../../../shared/utils/terminal-format'
import type { SchemaChangelogEntry } from '../../../shared/utils/terminal-types'

defineProps<{
  schemaVersion?: string
  changelog: SchemaChangelogEntry[]
}>()

const changelogUrl = `${manifest.links.github}/blob/main/CHANGELOG-data.md`

const appUrl = useRuntimeConfig().public.appUrl.replace(/\/+$/, '')

const parquetExample = [
  '-- DuckDB',
  `SELECT * FROM '${appUrl}/export/bulk/recent/prices_latest.parquet';`,
  '',
  '# pandas',
  `pd.read_parquet("${appUrl}/export/bulk/recent/prices_latest.parquet")`,
].join('\n')

const code = 'font-mono text-highlighted'
const link = 'text-primary underline underline-offset-2'
// A code block that can overflow is a focusable region, so a keyboard can scroll it (DESIGN.md › Scroll).
const block =
  'overflow-x-auto rounded-md border border-default bg-muted p-3 font-mono text-xs text-default focus-visible:outline-2 focus-visible:outline-primary'
</script>

<template>
  <TerminalPanel
    id="bulk"
    title="Bulk feed"
    note="For keeping a copy of every table in sync without paging through the API."
  >
    <div class="flex max-w-3xl flex-col gap-4 text-sm text-default">
      <p>
        <NuxtLink to="/export/bulk/manifest.json" external :class="`${link} font-mono`"
          >/export/bulk/manifest.json</NuxtLink
        >
        lists each table as a gzipped CSV and as a Parquet file, rebuilt once a day. Each entry has
        the file’s URL, rows, bytes, SHA-256, build time, schema version, and license, with the
        Parquet file’s under <code :class="code">parquet</code>. Compare the SHA-256 with your copy
        and download only what changed. The manifest and the files also answer
        <code :class="code">If-None-Match</code> with a 304.
      </p>
      <p>
        The files hold the last {{ LICENSE_WINDOW_DAYS }} days of each table that grows, and all of
        the rest, under {{ DATA_LICENSE.short }}. For every row, add
        <code :class="code">?{{ HISTORY_PARAM }}=full</code> to a table’s /export download. Its
        older rows are {{ HISTORY_LICENSE.short }}.
      </p>
      <p>
        A Parquet file has the same rows and columns as the CSV, typed by the
        <NuxtLink to="/export/dictionary.json" external :class="`${link} font-mono`"
          >data dictionary</NuxtLink
        >
        and compressed with gzip. Timestamps are UTC instants. The file’s metadata states its
        license too. DuckDB and pandas read one straight from its URL:
      </p>
      <pre
        :class="block"
        tabindex="0"
        role="region"
        aria-label="Reading a Parquet file with DuckDB and pandas"
      ><code>{{ parquetExample }}</code></pre>
      <p class="text-muted">
        Each IP address gets {{ count(REQUEST_BUDGETS.anonymous.read) }} requests a minute on each
        /api route and bulk file, and {{ count(REQUEST_BUDGETS.anonymous.export) }} on each /export
        table. Over the limit, you get a 429 with a Retry-After header.
      </p>
    </div>
  </TerminalPanel>

  <TerminalPanel
    id="schema"
    title="Schema versions"
    note="Every export and API response states its schema_version. These are the releases, newest first."
  >
    <template v-if="schemaVersion" #meta>
      Current: <span class="font-mono">{{ schemaVersion }}</span>
    </template>
    <div class="flex max-w-3xl flex-col gap-4 text-sm text-default">
      <ul class="flex list-disc flex-col gap-1 pl-5">
        <li>Adding a table or a column is a minor version.</li>
        <li>
          Removing or renaming one is a major version. We list it here 90 days before it ships.
        </li>
        <li>Changing what a column holds is a minor version, with a note.</li>
      </ul>
      <p class="text-muted">
        A JSON response has <code :class="code">schema_version</code> as a field. A CSV or a JSON
        array has it in the <code :class="code">X-Schema-Version</code> header.
      </p>
      <ol class="flex flex-col gap-3">
        <li v-for="release in changelog" :key="release.version" class="space-y-1">
          <p class="text-highlighted">
            <span class="font-mono">{{ release.version }}</span>
            <span class="text-muted">
              · <time :datetime="release.date">{{ release.date }}</time></span
            >
          </p>
          <p>{{ release.summary }}</p>
          <ul v-if="release.tables.length" class="flex list-disc flex-col gap-1 pl-5">
            <li v-for="t in release.tables" :key="t.name">
              <span class="font-mono">{{ t.name }}</span
              ><template v-if="t.added.length">
                adds <span class="font-mono">{{ t.added.join(', ') }}</span></template
              ><template v-if="t.removed.length">
                removes <span class="font-mono">{{ t.removed.join(', ') }}</span></template
              ><template v-for="r in t.renamed" :key="r.from">
                renames <span class="font-mono">{{ r.from }}</span> to
                <span class="font-mono">{{ r.to }}</span></template
              >.<template v-if="t.note"> {{ t.note }}</template>
            </li>
          </ul>
        </li>
      </ol>
    </div>
    <template #foot>
      Also in
      <a :href="changelogUrl" target="_blank" rel="noopener noreferrer" :class="link"
        >CHANGELOG-data.md</a
      >
      and under <span class="font-mono">changelog</span> in
      <NuxtLink to="/export/dictionary.json" external :class="`${link} font-mono`"
        >/export/dictionary.json</NuxtLink
      >.
    </template>
  </TerminalPanel>
</template>
