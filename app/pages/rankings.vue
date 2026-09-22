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

useSeo({
  title: 'Demand share',
  description:
    'Token share per frontier lab on OpenRouter — a public proxy for demand while the labs are private — with a 30-day series and top models per lab. CC BY 4.0.',
  dateModified: rankings.value?.as_of,
})
</script>

<template>
  <div class="space-y-12">
    <header class="space-y-2">
      <h1 class="text-4xl text-highlighted">Demand share</h1>
      <p class="max-w-2xl text-muted">
        Tokens routed through OpenRouter, per lab, from its published daily rankings. A proxy for
        relative demand while the labs are private — one aggregator’s traffic, never market share.
      </p>
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      title="Rankings could not be read"
      description="The rankings endpoint failed to respond. Nothing is shown rather than a stale or inferred number."
    />

    <template v-else-if="rankings">
      <TerminalPanel
        id="share"
        title="7-day share"
        :note="`${rankings.meta.coverage.days} day${rankings.meta.coverage.days === 1 ? '' : 's'} on record. Share is of every model in OpenRouter’s daily top 50 plus its aggregated “other” row.`"
      >
        <TerminalDemandShare :rankings="rankings" />
      </TerminalPanel>

      <TerminalPanel
        v-if="spend"
        id="spend"
        title="Implied spend share"
        note="Tokens to open-weight models, dollars to the frontier labs: the window’s tokens at each vendor’s published list price, as a low–high range with the join’s coverage on every row."
      >
        <TerminalSpendShare :spend="spend" />
      </TerminalPanel>

      <TerminalPanel
        v-if="rankings.status === 'ok'"
        id="series"
        title="30-day series"
        note="Tokens routed per UTC day, stacked by lab. Hover a column for its values; the table view lists them all."
      >
        <TerminalRankingsSeries :series="rankings.series" />
      </TerminalPanel>

      <TerminalPanel
        v-if="rankings.status === 'ok'"
        id="models"
        title="Top models per lab"
        note="Most-routed models in the share window, by tokens; the percentage is of the lab’s own window total."
      >
        <TerminalRankingsTopModels :providers="rankings.top_models" />
      </TerminalPanel>
    </template>
  </div>
</template>
