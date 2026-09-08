<script setup lang="ts">
// Demand share: each lab's slice of the tokens OpenRouter routed in the newest
// seven days, and how that slice moved against the seven before. A proxy, and
// held out as one: it is OpenRouter's traffic, not the market's, and the
// caveat, the CC BY 4.0 citation, and the two references that were evaluated
// and NOT ingested all ship visibly, not behind a control.
//
// Bars share one hue: DESIGN.md allows one accent per viewport, and identity
// here is carried by the row label, never by color alone.

import { absoluteStamp, ppLabel, sharePct } from '#shared/utils/terminal-format'
import type { RankingsData } from '#shared/utils/terminal-types'

const props = defineProps<{
  rankings: RankingsData
  /** On the landing page: a link to the full axis instead of the series. */
  compact?: boolean
}>()

const ONE_LINE_CAVEAT = 'OpenRouter share, not market share — one aggregator’s traffic'

/** Evaluated for this axis and cut (sources.yaml `cut`): linked, never fetched. */
const EXTERNAL = [
  { label: 'Artificial Analysis', url: 'https://artificialanalysis.ai/' },
  { label: 'LMArena (arena.ai)', url: 'https://arena.ai/' },
]

const window = computed(() => props.rankings.meta.coverage.window)
const prior = computed(() => props.rankings.meta.coverage.prior_window)
const widest = computed(() => Math.max(...props.rankings.shares.map((s) => s.share ?? 0), 0))
const widthPct = (share: number | null) =>
  `${widest.value > 0 && share !== null ? Math.max(1, Math.round((share / widest.value) * 100)) : 0}%`
</script>

<template>
  <div class="space-y-4">
    <TerminalEmptyState
      v-if="rankings.status === 'not_configured'"
      title="Not configured."
      body="The OpenRouter rankings dataset needs NUXT_OPENROUTER_API_KEY; without it the source is skipped every poll and nothing is fetched anonymously. The feed is registered and the panel appears the first tick after the key is set."
    />
    <TerminalEmptyState
      v-else-if="rankings.status === 'no_rows'"
      title="No rankings rows yet."
      body="The feed is registered; rows land on its first successful poll."
    />

    <template v-else>
      <p v-if="window" class="text-sm text-muted">
        Share of tokens routed, {{ window.from }} → {{ window.to }}
        <template v-if="prior"> · change vs {{ prior.from }} → {{ prior.to }}</template>
        <template v-else> · no earlier window to compare against yet</template>
      </p>

      <ul class="space-y-2">
        <li
          v-for="s in rankings.shares"
          :key="s.provider"
          class="grid grid-cols-[minmax(5rem,7rem)_1fr_auto] items-center gap-3 text-sm"
        >
          <span class="text-default">{{ s.display }}</span>
          <span class="h-3 overflow-hidden rounded bg-muted" aria-hidden="true">
            <span
              class="block h-full"
              :class="s.provider === 'other' ? 'bg-accented' : 'bg-primary'"
              :style="{ width: widthPct(s.share) }"
            />
          </span>
          <span class="whitespace-nowrap text-right font-mono">
            <span class="text-highlighted">{{ sharePct(s.share) }}</span>
            <span
              v-if="s.delta_pp !== null"
              class="ml-2 text-xs text-toned"
              :title="`prior window ${sharePct(s.prior_share)}`"
              >{{ ppLabel(s.delta_pp) }}</span
            >
          </span>
        </li>
      </ul>

      <p v-if="compact" class="text-sm">
        <NuxtLink to="/rankings" class="text-primary underline underline-offset-2">
          30-day series and top models per lab
        </NuxtLink>
      </p>
    </template>

    <!-- Provenance, license and caveat ship in every state, including the empty ones. -->
    <div class="space-y-1 text-xs text-toned">
      <p v-if="rankings.meta.citation">
        <a
          href="https://openrouter.ai/rankings"
          target="_blank"
          rel="noopener noreferrer"
          class="underline underline-offset-2 hover:text-default"
          >{{ rankings.meta.citation }}</a
        >
      </p>
      <p v-else-if="rankings.source.license">Licensed under {{ rankings.source.license }}.</p>
      <p class="flex flex-wrap items-center gap-x-2">
        <span>{{ ONE_LINE_CAVEAT }}</span>
        <TerminalCaveatMark
          v-if="rankings.source.caveat"
          name="Full caveat for the OpenRouter rankings source"
          :text="rankings.source.caveat"
        />
      </p>
      <p>
        <TerminalProvenanceTag
          v-if="rankings.provenance"
          :label="rankings.source.label"
          :source-url="rankings.provenance.source_url"
          :fetched-at="rankings.provenance.fetched_at"
        />
        <a
          v-else
          :href="rankings.source.url"
          target="_blank"
          rel="noopener noreferrer"
          class="underline underline-offset-2 hover:text-default"
          >{{ rankings.source.url }}</a
        >
        <template v-if="rankings.meta.as_of">
          · dataset as of
          <time :datetime="rankings.meta.as_of" :title="rankings.meta.as_of">{{
            absoluteStamp(rankings.meta.as_of)
          }}</time>
        </template>
      </p>
      <p>
        Also published, not ingested (license or no data endpoint — see coverage):
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
  </div>
</template>
