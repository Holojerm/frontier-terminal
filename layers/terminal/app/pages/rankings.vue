<script setup lang="ts">
// The demand-share axis in full: the share bars, the implied spend share
// the tokens decompose into at list price, the 30-day series, and each
// lab's top models — all from OpenRouter's usage rankings (CC BY 4.0) and,
// for the dollars, the vendors' own price pages.

import type { AdoptionData } from '../../shared/utils/recipe-views'
import type { RankingsData, SpendData } from '../../shared/utils/terminal-types'

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Demand',
    summary:
      'Each frontier lab’s share of tokens routed through OpenRouter over the newest seven days, the implied spend share at list price, a 30-day series and the top models per lab; then the share of US businesses on Ramp paying each lab, SDK and coding-agent downloads on npm and PyPI, and coding-agent pull requests on GitHub. None of it is market share.',
  },
})

const [{ data: rankings, error }, { data: spend }, { data: adoption }] = await Promise.all([
  useFetch<RankingsData>('/api/rankings'),
  useFetch<SpendData>('/api/spend'),
  useFetch<AdoptionData>('/api/adoption'),
])

const site = useSiteContext()

useSeo({
  title: 'AI lab demand: OpenRouter share, Ramp adoption, SDK downloads',
  description:
    'Demand for each frontier lab: OpenRouter token share, the share of US businesses on Ramp paying each lab, SDK and coding-agent downloads, agent pull requests.',
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
    title="Demand"
    lede="Tokens routed through OpenRouter per lab, then enterprise adoption, SDK downloads and coding-agent activity: each a different window on demand, none of them market share."
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
          :note="`${rankings.meta.coverage.days} day${rankings.meta.coverage.days === 1 ? '' : 's'} on record. Share of all OpenRouter tokens: its daily top 50 plus its “other” row.`"
        >
          <TerminalDemandShare :rankings="rankings" />
        </TerminalPanel>

        <TerminalPanel
          v-if="spend"
          id="spend"
          title="Implied spend share"
          note="The window’s tokens at each vendor’s list price, as a low–high range. Shares are of the tracked labs’ total, not of all OpenRouter traffic, so the token share here is larger than the one beside it."
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

    <template v-if="adoption">
      <TerminalPanel
        v-if="adoption.ramp"
        id="enterprise"
        title="Enterprise adoption"
        note="Share of US businesses on Ramp paying each vendor, monthly, from card and bill-pay spend: the enterprise side OpenRouter does not see."
      >
        <TerminalAdoptionRamp :ramp="adoption.ramp" :caveat="adoption.caveats.ramp" />
      </TerminalPanel>

      <div class="grid gap-6 lg:grid-cols-2">
        <TerminalPanel
          id="developers"
          title="SDK downloads"
          note="Each lab’s official SDKs on npm and PyPI, the newest 28 days against the 28 before."
        >
          <TerminalDownloadsTable
            :downloads="adoption.downloads"
            kind="sdk"
            :caveat="adoption.caveats.downloads"
          />
        </TerminalPanel>

        <TerminalPanel
          id="agents"
          title="Coding agents"
          note="Each lab’s coding agent: npm downloads, and the public pull requests it opens on GitHub."
        >
          <div class="space-y-4">
            <TerminalDownloadsTable
              :downloads="adoption.downloads"
              kind="agent"
              :caveat="adoption.caveats.downloads"
            />
            <TerminalAgentPrs :agents="adoption.agent_prs" :caveat="adoption.caveats.agent_prs" />
          </div>
        </TerminalPanel>
      </div>
    </template>
  </TerminalPage>
</template>
