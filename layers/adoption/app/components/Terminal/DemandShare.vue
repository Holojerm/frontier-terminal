<script setup lang="ts">
// Demand share: each lab's slice of the tokens OpenRouter routed in the newest seven days,
// and its move against the seven before. It is OpenRouter's traffic, not the market's, so
// the caveat, the CC BY 4.0 citation and the two references not ingested always ship visibly.

import type { RankingsData } from '../../../shared/types/rankings'

const watchlist = useWatchlist()

const stamps = useStamps()

const props = defineProps<{ rankings: RankingsData }>()

const window = computed(() => props.rankings.meta.coverage.window)
const prior = computed(() => props.rankings.meta.coverage.prior_window)
const widest = computed(() => Math.max(...props.rankings.shares.map((s) => s.share ?? 0), 0))
</script>

<template>
  <div class="space-y-3">
    <TerminalGap
      v-if="rankings.status === 'not_configured'"
      title="Not configured."
      reason="The OpenRouter rankings dataset needs NUXT_OPENROUTER_API_KEY, which this deploy doesn’t set. We don’t fetch it without one."
    />
    <TerminalGap
      v-else-if="rankings.status === 'no_rows'"
      title="No rankings data yet."
      reason="We haven’t fetched it successfully yet."
    />

    <template v-else>
      <p v-if="window" class="text-xs text-muted">
        {{ stamps.date(window.from) }} → {{ stamps.date(window.to) }}
        <template v-if="prior">
          · Δ vs {{ stamps.date(prior.from) }} → {{ stamps.date(prior.to) }}</template
        >
        <template v-else> · no earlier window yet</template>
      </p>

      <ul class="space-y-2">
        <li
          v-for="s in watchlist.first(rankings.shares, (s) => s.provider)"
          :key="s.provider"
          class="grid grid-cols-[minmax(5rem,7rem)_1fr_auto] items-center gap-3 text-sm"
        >
          <span class="text-default">{{ s.display }}</span>
          <TerminalBar
            :value="s.share"
            :max="widest"
            :tone="s.provider === 'other' ? 'neutral' : 'primary'"
          />
          <span class="whitespace-nowrap text-right font-mono">
            <span class="text-highlighted">{{ sharePct(s.share) }}</span>
            <span
              v-if="s.delta_pp !== null"
              class="ml-2 text-xs text-muted"
              :title="`prior window ${sharePct(s.prior_share)}`"
              >{{ ppLabel(s.delta_pp) }}</span
            >
          </span>
        </li>
      </ul>
    </template>

    <!-- Provenance, license and caveat ship in every state, including the empty ones. -->
    <TerminalSources
      :sources="
        rankings.provenance ? [{ label: rankings.source.label, ...rankings.provenance }] : []
      "
      :caveats="[
        {
          label: 'OpenRouter traffic only',
          text:
            rankings.source.caveat ??
            'One aggregator’s traffic. Treat it as a rough read on demand.',
        },
      ]"
    >
      <a
        v-if="!rankings.provenance"
        :href="rankings.source.url"
        target="_blank"
        rel="noopener noreferrer"
        class="leading-6 underline underline-offset-2 hover:text-default"
        >{{ rankings.source.url }}</a
      >
      <span v-if="rankings.meta.as_of">
        dataset as of
        <time :datetime="rankings.meta.as_of" :title="rankings.meta.as_of">{{
          stamps.absolute(rankings.meta.as_of)
        }}</time>
      </span>
      <a
        v-if="rankings.meta.citation"
        href="https://openrouter.ai/rankings"
        target="_blank"
        rel="noopener noreferrer"
        class="leading-6 underline underline-offset-2 hover:text-default"
        :title="rankings.meta.citation"
        >CC BY 4.0</a
      >
      <span v-else-if="rankings.source.license">{{ rankings.source.license }}</span>
    </TerminalSources>
  </div>
</template>
