<script setup lang="ts">
// What may be reused, and under what terms.
//
// The page exists because "open data" with no stated licence is not reusable:
// a careful reuser has to assume the worst, and an answer engine has nothing
// to cite terms from. The split it draws — code, our data by age, facts — is
// the honest one (shared/utils/license.ts), and the per-source table below is
// read from the coverage endpoint so this page and sources.yaml cannot disagree.

import manifest from '~~/fleet.json'

import {
  attributionLine,
  CODE_LICENSE,
  DATA_LICENSE,
  HISTORY_LICENSE,
  HISTORY_PARAM,
  LICENSE_WINDOW_DAYS,
} from '#shared/utils/license'
import type { CoverageData } from '../../shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'yearly',
    priority: '0.4',
    title: 'License',
    summary:
      'Our data from the last 90 days is CC BY 4.0. Older data is CC BY-NC 4.0, so commercial use of the full history needs a paid license. Anything published before 2026-11-04 stays CC BY 4.0. The code is MIT, and the underlying facts belong to their publishers.',
  },
})

const config = useRuntimeConfig()
const repo = manifest.links.github
const appUrl = config.public.appUrl.replace(/\/+$/, '')
const attribution = attributionLine(config.public.appName, appUrl)
const historyAttribution = attributionLine(config.public.appName, appUrl, HISTORY_LICENSE)

const { data: coverage } = await useFetch<CoverageData>('/api/coverage')

/** Only the sources that state terms of their own — the rest would be a guess. */
const licensed = computed(() => (coverage.value?.sources ?? []).filter((s) => s.license))

useSeo({
  title: 'License',
  description:
    'Data from the last 90 days is CC BY 4.0. The full history is CC BY-NC 4.0, so commercial use needs a paid license. The code is MIT. Attribution lines to copy.',
  dateModified: coverage.value?.as_of,
})
</script>

<template>
  <TerminalPage
    title="License"
    lede="Our data, the underlying facts, and the code are licensed separately. Our data’s license depends on its age."
    narrow
  >
    <TerminalPanel id="compilation" title="Our data">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          The tables, the change log, the alerts, the bulk exports, and the numbers we derive from
          them are our own work. That means which rows exist, how they’re timestamped and joined,
          and what we compute from them.
        </p>
        <ul class="list-disc space-y-2 pl-5">
          <li>
            <span class="text-highlighted">The last {{ LICENSE_WINDOW_DAYS }} days</span> are
            <a
              :href="DATA_LICENSE.url"
              target="_blank"
              rel="noopener noreferrer license"
              class="text-primary underline underline-offset-2"
              >{{ DATA_LICENSE.name }}</a
            >. You can quote, chart, republish, sell, and train on them, with attribution.
          </li>
          <li>
            <span class="text-highlighted">Anything older</span> (the full history) is
            <a
              :href="HISTORY_LICENSE.url"
              target="_blank"
              rel="noopener noreferrer license"
              class="text-primary underline underline-offset-2"
              >{{ HISTORY_LICENSE.name }}</a
            >. It’s free for non-commercial use, with attribution. Commercial use needs a paid
            license.
          </li>
        </ul>
        <p>
          A row’s age is its own date. For a filed fact that’s the period end. For a change it’s the
          day we saw it. The data dictionary on
          <NuxtLink to="/data#dictionary" class="text-primary underline underline-offset-2"
            >/data</NuxtLink
          >
          names the date for each table.
        </p>
        <p class="text-sm text-muted">Copy this line:</p>
        <p class="rounded border border-default p-3 font-mono text-sm text-highlighted">
          {{ attribution }}
        </p>
        <p class="text-sm text-muted">For the full history:</p>
        <p class="rounded border border-default p-3 font-mono text-sm text-highlighted">
          {{ historyAttribution }}
        </p>
        <p class="text-sm text-default">
          Want the full history in a product or a fund process, or terms your compliance team has
          signed?
          <NuxtLink to="/contact" class="text-primary underline underline-offset-2"
            >License it commercially</NuxtLink
          >.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel id="change" title="What changed on 2026-11-04">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          Before 2026-11-04 all of our data was {{ DATA_LICENSE.short }}. The age split applies to
          data we publish from that day on.
        </p>
        <p>
          Anything we published before then stays {{ DATA_LICENSE.short }}, however old it gets.
          That covers copies you already have and the same rows still on the site.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel id="where" title="Where the license shows">
      <ul class="max-w-2xl list-disc space-y-2 pl-5 text-default">
        <li>
          Pages show everything we hold, history included, and they’re free to read. Each data page
          says which license applies.
        </li>
        <li>
          A bulk export of a table that grows over time gives you the last
          {{ LICENSE_WINDOW_DAYS }} days. Add
          <code class="font-mono text-highlighted">?{{ HISTORY_PARAM }}=full</code> for every row.
          That download names {{ HISTORY_LICENSE.short }} in its headers and in its JSON wrapper,
          and a <span class="font-mono">license</span> column labels each row.
        </li>
        <li>
          Tables of current rows and lookups (latest prices, open roles, filers, entity securities),
          the data dictionary, and samples download whole.
        </li>
        <li>
          Every API response and MCP tool result has a
          <span class="font-mono">license</span> field naming the split. A response with an
          <span class="font-mono">as_of</span> older than {{ LICENSE_WINDOW_DAYS }} days is labeled
          {{ HISTORY_LICENSE.short }} in <span class="font-mono">point_in_time.license</span>.
        </li>
      </ul>
    </TerminalPanel>

    <TerminalPanel id="facts" title="The underlying facts">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          A price on Anthropic’s pricing page is Anthropic’s. A filing is EDGAR’s. An incident is
          the vendor’s own post. Nothing here relicenses any of that. A public fact like a number in
          an SEC filing isn’t ours to restrict. {{ HISTORY_LICENSE.short }} covers our compilation
          and the numbers we derive, not the facts in it.
        </p>
        <p>
          Data we pass on from someone else’s dataset keeps that dataset’s license at every age.
          That covers OpenRouter, Epoch AI, PyPI, npm, and GDELT. The
          <NuxtLink to="/contact#rights" class="text-primary underline underline-offset-2"
            >full list</NuxtLink
          >
          is on the contact page.
        </p>
        <p>
          Every row shows its source URL and when we fetched it, so the terms for any number come
          from the publisher that row names.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel
      id="sources"
      title="Sources that state their own terms"
      note="Each license as the source states it. Most sources state no terms, and we don’t fill any in."
    >
      <TerminalTable
        v-if="licensed.length"
        caption="Tracked sources with a stated data license"
        :columns="[
          { key: 'label', label: 'Source' },
          { key: 'license', label: 'Stated license', class: 'text-muted' },
        ]"
        :rows="licensed"
        :row-key="(s) => s.source_id"
        :edge="false"
      >
        <template #cell-label="{ row: source }">
          <a
            :href="source.url"
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary underline underline-offset-2"
            >{{ source.label }}</a
          >
        </template>
      </TerminalTable>
      <TerminalGap v-else inline title="No tracked source states a license of its own." />
      <p class="max-w-2xl text-sm text-muted">
        When a source asks for a specific attribution line, the page with its numbers prints it word
        for word (see
        <NuxtLink to="/rankings" class="text-primary underline underline-offset-2"
          >demand share</NuxtLink
        >).
      </p>
    </TerminalPanel>

    <TerminalPanel id="code" title="The code">
      <p class="max-w-2xl text-default">
        The pipeline, the parsers, and this site are under the
        <a
          :href="CODE_LICENSE.url"
          target="_blank"
          rel="noopener noreferrer license"
          class="text-primary underline underline-offset-2"
          >{{ CODE_LICENSE.name }}</a
        >, at
        <a
          :href="repo"
          target="_blank"
          rel="noopener noreferrer"
          class="text-primary underline underline-offset-2"
          >{{ repo }}</a
        >. Every source and parser is in the repo, so you can reproduce any number here.
      </p>
    </TerminalPanel>
  </TerminalPage>
</template>
