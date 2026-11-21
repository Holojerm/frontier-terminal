<script setup lang="ts">
// The pricing axis in full: the like-for-like matrix, then every SKU row the
// store holds with its delta against the previous revision.

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.9',
    title: 'Prices',
    summary:
      'Every API price and catalog entry per SKU for OpenAI, Anthropic, Google, xAI, Meta, Mistral, DeepSeek, Alibaba, and Moonshot AI, with the change since the previous price and the URL we read it from.',
  },
})

const { data: prices, error } = await useFetch<PricesData>('/api/prices')

// `?provider=xai` preselects the catalog filter (how a lab page links here).
const route = useRoute()
const provider = typeof route.query.provider === 'string' ? route.query.provider : undefined

const site = useSiteContext()

useSeo({
  title: 'LLM API pricing by lab',
  description:
    'API prices per million tokens for GPT, Claude, Gemini, Grok, Llama, Mistral, DeepSeek, and Qwen: a like-for-like matrix and every SKU, with source and time.',
  dateModified: prices.value?.as_of,
  schema: [
    datasetSchema(site, {
      url: usePageUrl(),
      name: 'Frontier AI lab API prices per million tokens',
      description:
        'The current list price of every API SKU OpenAI, Anthropic, Google, xAI, Meta, Mistral, DeepSeek, and Alibaba publish, per million input, cached-input, and output tokens, as read from each vendor’s own pricing page.',
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
          {{ prices.matrix.tier_note }}
        </template>
      </TerminalPanel>

      <TerminalPanel
        id="catalog"
        title="Full catalog"
        :note="`${prices.counts.priced} priced, ${prices.counts.catalog_only} catalog-only${prices.counts.removed ? `, ${prices.counts.removed} delisted` : ''}.`"
      >
        <TerminalGap
          v-if="prices.rows.length === 0"
          title="No models listed yet."
          reason="Prices appear after our first check of each vendor page."
          :action="{ label: 'See coverage', to: '/data#coverage' }"
        />
        <TerminalPriceTable v-else :prices="prices" :provider="provider" flow />
      </TerminalPanel>

      <TerminalPanel
        v-if="prices.reach?.length"
        id="history"
        title="How far back"
        note="How far back each lab’s price history goes, with the Internet Archive’s copies of its pricing page."
        flush
      >
        <TerminalArchiveReach :reach="prices.reach" flow />
      </TerminalPanel>
    </template>
  </TerminalPage>
</template>
