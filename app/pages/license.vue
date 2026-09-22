<script setup lang="ts">
// What may be reused, and under what terms.
//
// The page exists because "open data" with no stated licence is not reusable:
// a careful reuser has to assume the worst, and an answer engine has nothing
// to cite terms from. The three-way split it draws — code, compilation, facts
// — is the honest one, and the per-source table below is read from the
// coverage endpoint so this page and sources.yaml cannot disagree.

import manifest from '~~/fleet.json'

import { attributionLine, CODE_LICENSE, DATA_LICENSE } from '#shared/utils/license'
import type { CoverageData } from '#shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'yearly',
    priority: '0.4',
    title: 'License',
    summary:
      'The compilation is CC BY 4.0 and the code is MIT; the underlying facts belong to their publishers. The attribution string to copy, and the licence each source states for itself.',
  },
})

const config = useRuntimeConfig()
const repo = manifest.links.github
const appUrl = config.public.appUrl.replace(/\/+$/, '')
const attribution = attributionLine(config.public.appName, appUrl)

const { data: coverage } = await useFetch<CoverageData>('/api/coverage')

/** Only the sources that state terms of their own — the rest would be a guess. */
const licensed = computed(() => (coverage.value?.sources ?? []).filter((s) => s.license))

useSeo({
  title: 'License',
  description:
    'The compilation is CC BY 4.0, the code is MIT, and the underlying facts belong to their publishers. The attribution line to copy, and each source’s own terms.',
  dateModified: coverage.value?.as_of,
})
</script>

<template>
  <div class="space-y-12">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">License</h1>
      <p class="max-w-2xl text-muted">
        Three different things are licensed here, and they are not the same thing.
      </p>
    </header>

    <TerminalPanel id="compilation" title="The compilation">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          The tables, the change log, the alerts and the bulk exports — which rows exist, keyed,
          timestamped and joined — are this site’s own work, published under
          <a
            :href="DATA_LICENSE.url"
            target="_blank"
            rel="noopener noreferrer license"
            class="text-primary underline underline-offset-2"
            >{{ DATA_LICENSE.name }}</a
          >. Quote it, chart it, republish it, train on it. Attribution is the condition.
        </p>
        <p class="text-sm text-muted">Copy this line:</p>
        <p class="rounded-md bg-elevated p-3 font-mono text-sm text-highlighted">
          {{ attribution }}
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel id="facts" title="The underlying facts">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          A price on Anthropic’s pricing page is Anthropic’s. A filing is EDGAR’s. An incident is
          the vendor’s own post. Nothing here relicenses any of that, and the licence above does not
          reach it — it covers the compilation, not the contents.
        </p>
        <p>
          This is why every row carries the URL it was read from and the moment it was read. If you
          need terms for a particular number, the row tells you whose door to knock on.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel
      id="sources"
      title="Sources that state their own terms"
      note="Verbatim from sources.yaml. Most sources state none, and this page will not invent one on their behalf."
    >
      <div v-if="licensed.length" class="overflow-x-auto">
        <table class="w-full text-sm">
          <caption class="sr-only">
            Tracked sources with a stated data licence
          </caption>
          <thead>
            <tr class="border-b border-default text-left">
              <th scope="col" class="py-2 pr-4 font-medium text-muted">Source</th>
              <th scope="col" class="py-2 font-medium text-muted">Stated license</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="source in licensed" :key="source.source_id" class="border-b border-default">
              <th scope="row" class="py-3 pr-4 text-left font-normal">
                <a
                  :href="source.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-primary underline underline-offset-2"
                  >{{ source.label }}</a
                >
              </th>
              <td class="py-3 text-muted">{{ source.license }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="text-sm text-muted">
        No tracked source currently states a licence of its own.
      </p>
      <p class="max-w-2xl text-sm text-muted">
        Where a source requires a specific attribution string, the page that shows its numbers
        prints that string verbatim — see
        <NuxtLink to="/rankings" class="text-primary underline underline-offset-2"
          >demand share</NuxtLink
        >.
      </p>
    </TerminalPanel>

    <TerminalPanel id="code" title="The code">
      <p class="max-w-2xl text-default">
        The pipeline, the parsers and this site are
        <a
          :href="CODE_LICENSE.url"
          target="_blank"
          rel="noopener noreferrer license"
          class="text-primary underline underline-offset-2"
          >{{ CODE_LICENSE.name }}</a
        >:
        <a
          :href="repo"
          target="_blank"
          rel="noopener noreferrer"
          class="text-primary underline underline-offset-2"
          >{{ repo }}</a
        >. The source registry and every parser are in the repo, so any number here can be
        reproduced rather than taken on trust.
      </p>
    </TerminalPanel>
  </div>
</template>
