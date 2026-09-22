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
      'Every API price and catalog row per SKU for OpenAI, Anthropic, Google and xAI, with the change against the previous revision and the URL each was read from.',
  },
})

const { data: prices, error } = await useFetch<PricesData>('/api/prices')

// `?provider=xai` preselects the catalog filter — how a lab page hands off.
const route = useRoute()
const provider = typeof route.query.provider === 'string' ? route.query.provider : undefined

useSeo({
  title: 'Prices',
  description:
    'API pricing per million tokens across the frontier labs: the like-for-like matrix, the full SKU catalog, and each row’s source URL and fetch time.',
  dateModified: prices.value?.as_of,
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
        note="Flagship, balanced and economy on each vendor’s own recommendation."
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
          body="Pricing rows land on the first poll of each vendor page."
          :action="{ label: 'See coverage', to: '/data#coverage' }"
        />
        <TerminalPriceTable v-else :prices="prices" :provider="provider" />
      </TerminalPanel>
    </template>
  </div>
</template>
