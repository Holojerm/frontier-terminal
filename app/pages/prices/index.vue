<script setup lang="ts">
// The pricing axis in full: the like-for-like matrix, then every SKU row the
// store holds with its delta against the previous revision.

import type { PricesData } from '#shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.9',
    title: 'Prices',
    summary:
      'Every API price and catalog row per SKU for OpenAI, Anthropic, Google, xAI, Meta, and Mistral, with the change against the previous revision and the URL each was read from.',
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
  <div class="space-y-12">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">Prices</h1>
      <p class="max-w-2xl text-muted">
        $ per million tokens, read from each vendor’s own published page.
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Prices could not be read"
      description="The pricing endpoint failed to respond."
    />

    <template v-else-if="prices">
      <TerminalPanel
        id="matrix"
        title="Like-for-like"
        note="Flagship, balanced, and economy on each vendor’s own recommendation."
      >
        <TerminalPriceMatrix :matrix="prices.matrix" />
      </TerminalPanel>

      <TerminalPanel
        id="catalog"
        title="Full catalog"
        :note="`${prices.counts.priced} priced, ${prices.counts.catalog_only} catalog-only${prices.counts.removed ? `, ${prices.counts.removed} delisted` : ''}.`"
      >
        <TerminalEmptyState
          v-if="prices.rows.length === 0"
          title="No model rows yet."
          body="Pricing rows appear after the first poll of each vendor page."
          :action="{ label: 'See coverage', to: '/data#coverage' }"
        />
        <TerminalPriceTable v-else :prices="prices" :provider="provider" />
      </TerminalPanel>
    </template>
  </div>
</template>
