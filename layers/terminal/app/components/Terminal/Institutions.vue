<script setup lang="ts">
// /data's two panels for licensees: how an API key works, its rate limits, the
// bulk feed and its S3 bucket, the saved pages, webhooks (Webhooks.vue), and what the paid license covers; then the
// export schema's version and changelog. The limits are the numbers the server
// enforces (REQUEST_BUDGETS) and the changelog is the dictionary's, so neither
// can drift from what a client gets. No prices: those are by email.

import manifest from '~~/fleet.json'

import {
  DATA_LICENSE,
  HISTORY_LICENSE,
  LICENSE_WINDOW_DAYS,
  PAID_LICENSE,
} from '#shared/utils/license'
import { mailto } from '../../../shared/utils/contact'
import {
  KEY_HEADER_EXAMPLE,
  LICENSED_BUCKET,
  REQUEST_BUDGETS,
} from '../../../shared/utils/institutional'
import { count } from '../../../shared/utils/terminal-format'
import type { SchemaChangelogEntry } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

defineProps<{
  schemaVersion?: string
  changelog: SchemaChangelogEntry[]
}>()

const changelogUrl = `${manifest.links.github}/blob/main/CHANGELOG-data.md`

const perMinute = (n: number | undefined) => (n === undefined ? 'None' : `${count(n)} a minute`)

const LIMIT_COLUMNS: TableColumn[] = [
  { key: 'caller', label: 'Caller' },
  { key: 'read', label: '/api routes and bulk files', numeric: true },
  { key: 'export', label: '/export tables', numeric: true },
  { key: 'payload', label: 'Saved pages', numeric: true },
]

const limits = [
  { caller: 'No key, per IP address', ...REQUEST_BUDGETS.anonymous, payload: undefined },
  { caller: 'Research key', ...REQUEST_BUDGETS.research, payload: undefined },
  { caller: 'Systematic key', ...REQUEST_BUDGETS.systematic },
]

const appUrl = useRuntimeConfig().public.appUrl.replace(/\/+$/, '')

const parquetExample = [
  '-- DuckDB',
  `SELECT * FROM '${appUrl}/export/bulk/recent/prices_latest.parquet';`,
  '',
  '# pandas',
  `pd.read_parquet("${appUrl}/export/bulk/recent/prices_latest.parquet")`,
].join('\n')

const s3Example = [
  '-- DuckDB',
  "CREATE SECRET (TYPE r2, KEY_ID '<access key id>', SECRET '<secret>', ACCOUNT_ID '<account id>');",
  `SELECT * FROM 'r2://${LICENSED_BUCKET}/full/changes.parquet';`,
  '',
  '# pandas (with s3fs)',
  `pd.read_parquet("s3://${LICENSED_BUCKET}/full/changes.parquet", storage_options={`,
  '    "key": "<access key id>", "secret": "<secret>",',
  '    "client_kwargs": {"endpoint_url": "https://<account id>.r2.cloudflarestorage.com"}})',
].join('\n')

const code = 'font-mono text-highlighted'
const link = 'text-primary underline underline-offset-2'
// A code block that can overflow is a focusable region, so a keyboard can scroll it (DESIGN.md › Scroll).
const block =
  'overflow-x-auto rounded-md border border-default bg-muted p-3 font-mono text-xs text-default focus-visible:outline-2 focus-visible:outline-primary'
</script>

<template>
  <TerminalPanel
    id="institutions"
    title="For institutions"
    note="API keys for licensees: higher rate limits, the full history under a paid license, a daily bulk feed in CSV and Parquet (also over S3), and alert webhooks."
  >
    <div class="flex max-w-3xl flex-col gap-4 text-sm text-default">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p class="max-w-2xl">
          Funds and research teams can license the full history for commercial use. We issue each
          licensee an API key by hand. There’s no sign-up, and pricing is by email.
        </p>
        <UButton
          :to="mailto('API key')"
          external
          icon="i-lucide-mail"
          label="Ask for a key"
          class="self-start sm:self-auto"
        />
      </div>

      <section class="space-y-2" aria-labelledby="institutions-keys">
        <h3 id="institutions-keys" class="text-highlighted">How keys work</h3>
        <ul class="flex list-disc flex-col gap-1 pl-5">
          <li>
            Send the key in a header: <code :class="code">{{ KEY_HEADER_EXAMPLE }}</code
            >. A request without one is served the way it is today.
          </li>
          <li>
            A key raises your rate limits and labels older rows with your license instead of
            {{ HISTORY_LICENSE.short }}. It doesn’t change the data. You get the same rows at the
            same moment as everyone else.
          </li>
          <li>
            A wrong, expired, or revoked key gets a 401 that says which. We never serve it as a
            request without a key.
          </li>
          <li>A key lasts for its license term, usually 12 months, and doesn’t renew itself.</li>
        </ul>
      </section>

      <section class="space-y-2" aria-labelledby="institutions-limits">
        <h3 id="institutions-limits" class="text-highlighted">Rate limits</h3>
        <TerminalTable
          caption="Requests a minute, per route, for each kind of caller"
          :columns="LIMIT_COLUMNS"
          :rows="limits"
          :row-key="(r) => r.caller"
          :edge="false"
        >
          <template #cell-read="{ row }">{{ perMinute(row.read) }}</template>
          <template #cell-export="{ row }">{{ perMinute(row.export) }}</template>
          <template #cell-payload="{ row }">{{ perMinute(row.payload) }}</template>
        </TerminalTable>
        <p class="text-muted">
          Each route counts on its own. Over the limit, you get a 429 with a Retry-After header.
        </p>
      </section>

      <section class="space-y-2" aria-labelledby="institutions-bulk">
        <h3 id="institutions-bulk" class="text-highlighted">Bulk feed</h3>
        <p>
          <NuxtLink to="/export/bulk/manifest.json" external :class="`${link} font-mono`"
            >/export/bulk/manifest.json</NuxtLink
          >
          lists each table as a gzipped CSV and as a Parquet file, rebuilt once a day. Each entry
          has the file’s URL, rows, bytes, SHA-256, build time, schema version, and license, with
          the Parquet file’s under <code :class="code">parquet</code>. Compare the SHA-256 with your
          copy and download only what changed. The manifest and the files also answer
          <code :class="code">If-None-Match</code> with a 304.
        </p>
        <p>
          Without a key you get the last {{ LICENSE_WINDOW_DAYS }} days of each table that grows,
          and all of the rest, under {{ DATA_LICENSE.short }}. With a key you get every row, each
          labeled in a <code :class="code">license</code> column.
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
          With a key, send it as the <code :class="code">Authorization</code> header (in DuckDB, a
          secret of <code :class="code">TYPE http</code> with that header) and read the
          <span class="font-mono">full</span> file instead.
        </p>
      </section>

      <section class="space-y-2" aria-labelledby="institutions-s3">
        <h3 id="institutions-s3" class="text-highlighted">S3 access</h3>
        <p>
          Licensees can also read the full-history files from an S3-compatible bucket on Cloudflare
          R2. Ask with your key and we’ll send read-only credentials: an access key ID, a secret,
          and the endpoint. They open this one bucket and end when your key does.
        </p>
        <p>
          The bucket is <code :class="code">{{ LICENSED_BUCKET }}</code
          >. It holds <code :class="code">full/&lt;table&gt;.csv.gz</code>,
          <code :class="code">full/&lt;table&gt;.parquet</code>, and
          <code :class="code">manifest.json</code>, the same files the keyed manifest lists. Set the
          region to <code :class="code">auto</code>.
        </p>
        <pre
          :class="block"
          tabindex="0"
          role="region"
          aria-label="Reading the licensed bucket with DuckDB and pandas"
        ><code>{{ s3Example }}</code></pre>
      </section>

      <section class="space-y-2" aria-labelledby="institutions-payloads">
        <h3 id="institutions-payloads" class="text-highlighted">Saved pages</h3>
        <p>
          With a systematic key,
          <code :class="code">/export/payloads/&lt;snapshot id&gt;</code> returns the page we read,
          byte for byte, for any snapshot in
          <NuxtLink to="/export/snapshots.csv" external :class="`${link} font-mono`"
            >/export/snapshots</NuxtLink
          >. Only for sources that are ours to license. A source whose terms restrict automated
          reading, one we haven’t cleared, or someone else’s dataset gets a 403.
        </p>
      </section>

      <TerminalWebhooks :schema-version="schemaVersion" />

      <section class="space-y-2" aria-labelledby="institutions-scope">
        <h3 id="institutions-scope" class="text-highlighted">What the paid license covers</h3>
        <p>
          The {{ PAID_LICENSE.short }} covers our compilation and the numbers we derive, over the
          full history, for commercial use under your signed terms. The facts still belong to their
          publishers. Where a publisher’s site terms restrict automated reading, the license covers
          our compilation of those rows and names the restriction. Upstream
          {{ DATA_LICENSE.short }} data keeps its own attribution condition, and sources we haven’t
          cleared aren’t in it.
          <NuxtLink to="/contact#rights" :class="link">See which sources are in each group</NuxtLink
          >.
        </p>
      </section>
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
          Removing or renaming one is a major version. Licensees hear about it 90 days before it
          ships.
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
