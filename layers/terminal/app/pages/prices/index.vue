<script setup lang="ts">
// The pricing axis in full: the like-for-like matrix, then every SKU row the
// store holds with its delta against the previous revision.

import type { PricesData } from '../../../shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.9',
    title: 'Prices',
    summary:
      'Every API price and catalog entry per SKU for OpenAI, Anthropic, Google, xAI, Meta, and Mistral, with the change since the previous price and the URL we read it from.',
  },
})

const { data: prices, error } = await useFetch<PricesData>('/api/prices')

// `?provider=xai` preselects the catalog filter — how a lab page hands off.
const route = useRoute()
const provider = typeof route.query.provider === 'string' ? route.query.provider : undefined

const site = useSiteContext()

useSeo({
  title: 'LLM API pricing by lab',
  description:
    'API prices per million tokens for GPT, Claude, Gemini, Grok, Llama, and Mistral models: a like-for-like matrix and every SKU, each with source and fetch time.',
  dateModified: prices.value?.as_of,
  schema: [
    datasetSchema(site, {
      url: usePageUrl(),
      name: 'Frontier AI lab API prices per million tokens',
      description:
        'The current list price of every API SKU OpenAI, Anthropic, Google, xAI, Meta, and Mistral publish, per million input, cached-input, and output tokens, as read from each vendor’s own pricing page.',
      dateModified: prices.value?.as_of,
      variableMeasured: ['input_per_mtok', 'cached_input_per_mtok', 'output_per_mtok'],
      distribution: exportDistribution(site, 'prices_latest'),
    }),
  ],
})
</script>

<template>
  <TerminalPage
    title="Prices"
    lede="$ per million tokens, read from each vendor’s own published page."
    :as-of="prices?.as_of"
    :error="Boolean(error)"
    error-title="Prices didn’t load"
    error-body="Try reloading in a minute."
  >
    <template v-if="prices">
      <TerminalPanel
        id="matrix"
        title="Like-for-like"
        note="Flagship, balanced, and economy on each vendor’s own recommendation."
        flush
      >
        <TerminalPriceMatrix :matrix="prices.matrix" />
        <template #foot>
          {{ prices.matrix.tier_note }} Each placement follows the vendor’s own docs. The info
          button quotes the sentence.
        </template>
      </TerminalPanel>

      <TerminalPanel
        id="catalog"
        title="Full catalog"
        :note="`${prices.counts.priced} priced, ${prices.counts.catalog_only} catalog-only${prices.counts.removed ? `, ${prices.counts.removed} delisted` : ''}.`"
      >
        <TerminalGap
          v-if="prices.rows.length === 0"
          title="No model rows yet."
          reason="Prices appear after our first check of each vendor page."
          :action="{ label: 'See coverage', to: '/data#coverage' }"
        />
        <TerminalPriceTable v-else :prices="prices" :provider="provider" flow />
      </TerminalPanel>

      <TerminalPanel
        v-if="prices.reach?.length"
        id="history"
        title="How far back"
        note="Each SKU’s page shows its full price history. Before we started checking, it comes from the Internet Archive’s copies of the lab’s own pricing page."
        flush
      >
        <TerminalPriceReach :reach="prices.reach" />
      </TerminalPanel>
    </template>
  </TerminalPage>
</template>
