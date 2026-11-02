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
import type { CoverageData } from '../../shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'yearly',
    priority: '0.4',
    title: 'License',
    summary:
      'The compilation is CC BY 4.0 and the code is MIT; the underlying facts belong to their publishers. The attribution line to copy, and the license each source states for itself.',
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
  <TerminalPage
    title="License"
    lede="The compilation, the underlying facts, and the code are licensed separately."
    narrow
  >
    <TerminalPanel id="compilation" title="The compilation">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          The tables, the change log, the alerts, and the bulk exports — which rows exist, keyed,
          timestamped, and joined — are this site’s own work, published under
          <a
            :href="DATA_LICENSE.url"
            target="_blank"
            rel="noopener noreferrer license"
            class="text-primary underline underline-offset-2"
            >{{ DATA_LICENSE.name }}</a
          >. It may be quoted, charted, republished, and used for training, with attribution.
        </p>
        <p class="text-sm text-muted">Copy this line:</p>
        <p class="rounded border border-default p-3 font-mono text-sm text-highlighted">
          {{ attribution }}
        </p>
        <p class="text-sm text-default">
          Can’t meet the attribution condition, or need terms your compliance team has signed?
          <NuxtLink to="/contact" class="text-primary underline underline-offset-2"
            >License it commercially</NuxtLink
          >.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel id="facts" title="The underlying facts">
      <div class="max-w-2xl space-y-3 text-default">
        <p>
          A price on Anthropic’s pricing page is Anthropic’s. A filing is EDGAR’s. An incident is
          the vendor’s own post. Nothing here relicenses any of that; the license above covers the
          compilation, not the contents.
        </p>
        <p>
          Every row carries its source URL and fetch timestamp, so the terms for any number come
          from the publisher that row names.
        </p>
      </div>
    </TerminalPanel>

    <TerminalPanel
      id="sources"
      title="Sources that state their own terms"
      note="Verbatim from sources.yaml. Most sources state no terms, and none are supplied for them."
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
        Where a source requires a specific attribution string, the page showing its numbers prints
        it verbatim — see
        <NuxtLink to="/rankings" class="text-primary underline underline-offset-2"
          >demand share</NuxtLink
        >.
      </p>
    </TerminalPanel>

    <TerminalPanel id="code" title="The code">
      <p class="max-w-2xl text-default">
        The pipeline, the parsers, and this site are
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
        reproduced.
      </p>
    </TerminalPanel>
  </TerminalPage>
</template>
