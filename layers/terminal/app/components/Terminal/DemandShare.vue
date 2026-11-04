<script setup lang="ts">
// Demand share: each lab's slice of the tokens OpenRouter routed in the newest
// seven days, and how that slice moved against the seven before. A proxy, and
// held out as one: it is OpenRouter's traffic, not the market's, and the
// caveat, the CC BY 4.0 citation, and the two references that were evaluated
// and NOT ingested all ship visibly, not behind a control.

import { absoluteStamp, ppLabel, sharePct } from '../../../shared/utils/terminal-format'
import type { RankingsData } from '../../../shared/utils/terminal-types'

const props = defineProps<{
  rankings: RankingsData
  /** On the landing page: drop the list of references evaluated and not ingested. */
  compact?: boolean
}>()

/** Evaluated for this axis and cut (sources.yaml `cut`): linked, never fetched. */
const EXTERNAL = [
  { label: 'Artificial Analysis', url: 'https://artificialanalysis.ai/' },
  { label: 'LMArena (arena.ai)', url: 'https://arena.ai/' },
]

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
        {{ window.from }} → {{ window.to }}
        <template v-if="prior"> · Δ vs {{ prior.from }} → {{ prior.to }}</template>
        <template v-else> · no earlier window yet</template>
      </p>

      <ul class="space-y-2">
        <li
          v-for="s in rankings.shares"
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
        class="underline underline-offset-2 hover:text-default"
        >{{ rankings.source.url }}</a
      >
      <span v-if="rankings.meta.as_of">
        dataset as of
        <time :datetime="rankings.meta.as_of" :title="rankings.meta.as_of">{{
          absoluteStamp(rankings.meta.as_of)
        }}</time>
      </span>
      <a
        v-if="rankings.meta.citation"
        href="https://openrouter.ai/rankings"
        target="_blank"
        rel="noopener noreferrer"
        class="underline underline-offset-2 hover:text-default"
        :title="rankings.meta.citation"
        >CC BY 4.0</a
      >
      <span v-else-if="rankings.source.license">{{ rankings.source.license }}</span>
    </TerminalSources>
    <p v-if="!compact" class="text-xs text-muted">
      Considered and left out (license terms, or no data feed):
      <template v-for="(ref, i) in EXTERNAL" :key="ref.url">
        <a
          :href="ref.url"
          target="_blank"
          rel="noopener noreferrer"
          class="underline underline-offset-2 hover:text-default"
          >{{ ref.label }}</a
        ><template v-if="i < EXTERNAL.length - 1">, </template>
      </template>
    </p>
  </div>
</template>
