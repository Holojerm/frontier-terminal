<script setup lang="ts">
// The demand-share axis in full: share bars, implied spend share at list price, the 30-day
// series and each lab's top models, from OpenRouter's usage rankings (CC BY 4.0) and the
// vendors' price pages.

definePageMeta({
  publicPage: {
    changefreq: 'daily',
    priority: '0.8',
    title: 'Demand',
    summary:
      'Each frontier lab’s share of tokens routed through OpenRouter over the newest seven days, the implied spend share at list price, a 30-day series, weekly share over the whole history and the top models per lab; then the share of US businesses on Ramp paying each lab, SDK and coding-agent downloads on npm and PyPI, and coding-agent pull requests on GitHub, each also by week over everything stored. None of it is market share.',
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
    // No distribution: the per-model rows are not bulk-exported (OpenRouter's
    // terms; docs/source-audit.md). What the page renders is the per-lab fold.
    datasetSchema(site, {
      url: usePageUrl(),
      name: 'OpenRouter tokens per lab per day',
      description:
        'Total tokens routed through OpenRouter per UTC day, folded into each frontier lab’s share, from OpenRouter’s public usage rankings. It covers one aggregator’s traffic only. Source: OpenRouter (openrouter.ai/rankings), licensed CC BY 4.0.',
      dateModified: rankings.value?.as_of,
      temporalCoverage: rankings.value?.meta.coverage.first_date
        ? `${rankings.value.meta.coverage.first_date}/${rankings.value.meta.coverage.last_date ?? '..'}`
        : null,
      variableMeasured: ['date', 'provider', 'tokens', 'share'],
      isBasedOn: ['https://openrouter.ai/rankings'],
    }),
  ],
})

// Three windows on demand, one tab each: what OpenRouter routes, which
// businesses pay, and what developers install. A window with no payload gets
// no tab.
const tabs = computed(() => [
  ...(rankings.value ? [{ value: 'openrouter', label: 'OpenRouter' }] : []),
  ...(adoption.value?.ramp ? [{ value: 'enterprise', label: 'Enterprise' }] : []),
  ...(adoption.value ? [{ value: 'developers', label: 'Developers' }] : []),
])
</script>

<template>
  <TerminalPage
    title="Demand"
    lede="OpenRouter tokens per lab, enterprise adoption, SDK downloads, and coding-agent activity. None of them is market share."
    :as-of="rankings?.as_of"
    :error="Boolean(error)"
    error-title="Rankings didn’t load"
    error-body="Try reloading in a minute."
  >
    <TerminalTabs :tabs="tabs">
      <template #openrouter>
        <template v-if="rankings">
          <div class="grid gap-6 lg:grid-cols-2">
            <TerminalPanel
              id="share"
              title="7-day share"
              note="Share of all OpenRouter tokens, last 7 days."
            >
              <TerminalDemandShare :rankings="rankings" />
            </TerminalPanel>

            <TerminalPanel
              v-if="spend"
              id="spend"
              title="Implied spend share"
              note="The same tokens at list price, as a low–high range."
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
            id="weekly"
            title="Weekly share"
            note="Share of all OpenRouter tokens per week. The charts share one y-axis."
          >
            <TerminalRankingsWeekly :rankings="rankings" />
          </TerminalPanel>

          <TerminalPanel
            v-if="rankings.status === 'ok'"
            id="models"
            title="Top models per lab"
            note="Most-routed models per lab. Each percentage is of the lab’s own total."
          >
            <TerminalRankingsTopModels :providers="rankings.top_models" />
          </TerminalPanel>
        </template>
      </template>

      <template #enterprise>
        <template v-if="adoption?.ramp">
          <TerminalPanel
            id="enterprise"
            title="Enterprise adoption"
            note="Share of US businesses on Ramp paying each vendor, monthly."
          >
            <TerminalAdoptionRamp :ramp="adoption.ramp" :caveat="adoption.caveats.ramp" />
          </TerminalPanel>
        </template>
      </template>

      <template #developers>
        <template v-if="adoption">
          <div class="grid gap-6 lg:grid-cols-2">
            <TerminalPanel
              id="developers"
              title="SDK downloads"
              note="Each lab’s official SDKs on npm and PyPI, the last 28 days against the 28 before."
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
                <TerminalAgentPrs
                  :agents="adoption.agent_prs"
                  :caveat="adoption.caveats.agent_prs"
                />
              </div>
            </TerminalPanel>
          </div>

          <TerminalPanel
            id="sdk-weekly"
            title="SDK downloads by week"
            note="Downloads per week. Each chart has its own scale."
            class="mt-6"
          >
            <TerminalDownloadsWeekly
              :downloads="adoption.downloads"
              kind="sdk"
              :caveat="adoption.caveats.downloads"
            />
          </TerminalPanel>

          <TerminalPanel
            id="sdk-share"
            title="SDK share by week"
            note="Each lab’s main SDK as a share of the tracked labs’ main SDKs on the same registry."
            class="mt-6"
          >
            <TerminalDownloadsWeekly
              :downloads="adoption.downloads"
              kind="sdk"
              measure="share"
              :caveat="adoption.caveats.share"
            />
          </TerminalPanel>

          <TerminalPanel
            id="sdk-adjusted"
            title="SDK downloads against npm"
            note="npm downloads per week at June 2025’s registry volume. Each chart has its own scale."
            class="mt-6"
          >
            <TerminalDownloadsWeekly
              :downloads="adoption.downloads"
              kind="sdk"
              measure="normalized"
              :caveat="adoption.caveats.normalized"
            />
          </TerminalPanel>

          <TerminalPanel
            id="agents-weekly"
            title="Coding agents by week"
            note="npm downloads and public GitHub pull requests per week. Each chart has its own scale."
            class="mt-6"
          >
            <div class="space-y-6">
              <TerminalDownloadsWeekly
                :downloads="adoption.downloads"
                kind="agent"
                :caveat="adoption.caveats.downloads"
              />
              <TerminalAgentPrsWeekly
                :agents="adoption.agent_prs"
                :caveat="adoption.caveats.agent_prs"
              />
            </div>
          </TerminalPanel>
        </template>
      </template>
    </TerminalTabs>
  </TerminalPage>
</template>
