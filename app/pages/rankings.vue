<script setup lang="ts">
// The demand-share axis in full: the share bars, the implied spend share
// the tokens decompose into at list price, the 30-day series, and each
// lab's top models — all from OpenRouter's usage rankings (CC BY 4.0) and,
// for the dollars, the vendors' own price pages.

import type { RankingsData, SpendData } from '#shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Demand share',
    summary:
      'Each frontier lab’s share of tokens routed through OpenRouter over the newest seven days, the implied spend share those tokens carry at list price, a 30-day daily series, and the top models per lab — OpenRouter share, not market share.',
  },
})

const [{ data: rankings, error }, { data: spend }] = await Promise.all([
  useFetch<RankingsData>('/api/rankings'),
  useFetch<SpendData>('/api/spend'),
])

const site = useSiteContext()

useSeo({
  title: 'OpenRouter token share by AI lab',
  description:
    'Token share per frontier lab on OpenRouter — a public proxy for demand while the labs are private — with a 30-day series and top models per lab. CC BY 4.0.',
  dateModified: rankings.value?.as_of,
  schema: [
    datasetSchema(site, {
      url: usePageUrl(),
      name: 'OpenRouter tokens per model per day',
      description:
        'Total tokens routed through OpenRouter per UTC day and model, from OpenRouter’s public usage rankings. One channel’s share, not market share. Source: OpenRouter (openrouter.ai/rankings).',
      dateModified: rankings.value?.as_of,
      variableMeasured: ['date', 'model_permaslug', 'total_tokens'],
      distribution: exportDistribution(site, 'rankings_daily'),
    }),
  ],
})
</script>

<template>
  <TerminalPage
    title="Demand share"
    lede="Tokens routed through OpenRouter, per lab. One aggregator’s traffic, not market share."
    :as-of="rankings?.as_of"
    :error="Boolean(error)"
    error-title="Rankings could not be read"
    error-body="The rankings endpoint failed to respond."
  >
    <template v-if="rankings">
      <div class="grid gap-6 lg:grid-cols-2">
        <TerminalPanel
          id="share"
          title="7-day share"
          :note="`${rankings.meta.coverage.days} day${rankings.meta.coverage.days === 1 ? '' : 's'} on record. Share of OpenRouter’s daily top 50 plus its “other” row.`"
        >
          <TerminalDemandShare :rankings="rankings" />
        </TerminalPanel>

        <TerminalPanel
          v-if="spend"
          id="spend"
          title="Implied spend share"
          note="The window’s tokens at each vendor’s list price, as a low–high range."
        >
          <TerminalSpendShare :spend="spend" />
        </TerminalPanel>
      </div>

      <TerminalPanel
        v-if="rankings.status === 'ok'"
        id="series"
        title="30-day series"
        note="Tokens routed per UTC day, stacked by lab."
      >
        <TerminalRankingsSeries :series="rankings.series" />
      </TerminalPanel>

      <TerminalPanel
        v-if="rankings.status === 'ok'"
        id="models"
        title="Top models per lab"
        note="Most-routed models per lab; the percentage is of the lab’s own total."
      >
        <TerminalRankingsTopModels :providers="rankings.top_models" />
      </TerminalPanel>
    </template>
  </TerminalPage>
</template>
