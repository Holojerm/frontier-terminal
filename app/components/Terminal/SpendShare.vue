<script setup lang="ts">
// Implied spend share: the demand-share tokens joined to each vendor's
// list prices. Rendered as a range per lab (every token at the input price
// to every token at the output price), beside the token share it was
// derived from, with the join's coverage on every row and the labs it
// could not price named rather than shown at zero. Third-party channel,
// list price, disclosed as both.

import { compactTokens, compactUsd, sharePct } from '#shared/utils/terminal-format'
import type { SpendData, SpendProviderView } from '#shared/utils/terminal-types'

const props = defineProps<{
  spend: SpendData
  /** On the landing page: the rows and a link, no per-model join. */
  compact?: boolean
}>()

// A range reads min–max. Dollars are ordered by construction (input price ≤
// output price); a share is not — a lab with cheap output can hold a larger
// slice at the input bound than at the output bound — so both ends are
// sorted before printing.
const range = (a: number | null, b: number | null, f: (n: number) => string) => {
  if (a === null || b === null) return '—'
  const [low, high] = a <= b ? [a, b] : [b, a]
  return f(low) === f(high) ? f(low) : `${f(low)}–${f(high)}`
}

const widest = computed(() => Math.max(...props.spend.providers.map((p) => p.share_high ?? 0), 0))
const widthPct = (share: number | null) =>
  `${widest.value > 0 && share !== null ? Math.max(1, Math.round((share / widest.value) * 100)) : 0}%`

const priced = (p: SpendProviderView) => p.priced_tokens > 0

const showJoin = ref(false)
const joined = computed(() => props.spend.providers.filter((p) => p.models.length))
</script>

<template>
  <div class="space-y-4">
    <TerminalEmptyState
      v-if="spend.status === 'not_configured'"
      title="Not configured."
      body="The join needs the OpenRouter rankings, which need NUXT_OPENROUTER_API_KEY; nothing is fetched anonymously."
    />
    <TerminalEmptyState
      v-else-if="spend.status === 'no_rows'"
      title="No rankings rows yet."
      body="The rankings feed is registered; the join runs on its first successful poll."
    />

    <template v-else>
      <p v-if="spend.window" class="text-sm text-muted">
        Tokens routed {{ spend.window.from }} → {{ spend.window.to }}, at each vendor’s list price
        as published — implied, not observed.
      </p>

      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <caption class="sr-only">
            Implied OpenRouter-channel spend per lab, as a range, beside token share and price
            coverage
          </caption>
          <thead>
            <tr class="border-b border-default text-left">
              <th scope="col" class="py-2 pr-3 font-medium text-toned">Lab</th>
              <th scope="col" class="py-2 pr-3 font-medium text-toned">Spend share</th>
              <th scope="col" class="py-2 pr-3 text-right font-medium text-toned">Implied $</th>
              <th scope="col" class="py-2 pr-3 text-right font-medium text-toned">Token share</th>
              <th scope="col" class="py-2 text-right font-medium text-toned">Priced</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in spend.providers" :key="p.provider" class="border-b border-default">
              <th scope="row" class="py-2 pr-3 text-left font-normal text-default">
                {{ p.display }}
              </th>
              <td class="py-2 pr-3">
                <div v-if="priced(p)" class="flex items-center gap-2">
                  <span class="h-3 w-24 overflow-hidden rounded bg-muted" aria-hidden="true">
                    <span
                      class="block h-full bg-primary"
                      :style="{ width: widthPct(p.share_high) }"
                    />
                  </span>
                  <span class="whitespace-nowrap font-mono text-highlighted">
                    {{ range(p.share_low, p.share_high, sharePct) }}
                  </span>
                </div>
                <span v-else class="text-xs text-toned">not priceable — see below</span>
              </td>
              <td class="whitespace-nowrap py-2 pr-3 text-right font-mono text-default">
                {{ priced(p) ? range(p.spend_low, p.spend_high, compactUsd) : '—' }}
              </td>
              <td class="whitespace-nowrap py-2 pr-3 text-right font-mono text-toned">
                {{ sharePct(p.token_share) }}
                <span class="text-xs">· {{ compactTokens(p.tokens) }}</span>
              </td>
              <td class="whitespace-nowrap py-2 text-right font-mono text-toned">
                {{ sharePct(p.coverage) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <UAlert
        v-if="spend.excluded.length"
        color="info"
        variant="soft"
        icon="i-lucide-eye-off"
        title="In the token share, out of the dollar share"
        :description="
          spend.excluded.map((e) => `${e.display}: ${e.reason}.`).join(' ') +
          ' The spend share is among the labs that could be priced, and says nothing about the rest.'
        "
      />

      <p class="text-xs text-toned">
        {{ compactTokens(spend.totals.other_tokens) }} of
        {{ compactTokens(spend.totals.tokens) }} tokens in the window went to models outside the
        four labs (open-weight and others) and are not priced here — the “tokens to open source,
        economics to the frontier labs” split this table exists to show.
      </p>

      <UCollapsible v-if="!compact && joined.length" v-model:open="showJoin" class="space-y-2">
        <UButton
          variant="link"
          color="neutral"
          size="sm"
          trailing-icon="i-lucide-chevron-down"
          class="px-0 text-toned"
          :label="showJoin ? 'Hide the join per model' : 'Show the join per model'"
        />
        <template #content>
          <div class="space-y-4">
            <div v-for="p in joined" :key="p.provider" class="overflow-x-auto">
              <h3 class="mb-1 text-sm text-highlighted">{{ p.display }}</h3>
              <table class="w-full text-xs">
                <caption class="sr-only">
                  {{
                    p.display
                  }}
                  ranked models joined to catalog SKUs
                </caption>
                <thead>
                  <tr class="border-b border-default text-left">
                    <th scope="col" class="py-1 pr-2 font-medium text-toned">OpenRouter model</th>
                    <th scope="col" class="py-1 pr-2 text-right font-medium text-toned">Tokens</th>
                    <th scope="col" class="py-1 pr-2 font-medium text-toned">Catalog SKU</th>
                    <th scope="col" class="py-1 pr-2 text-right font-medium text-toned">
                      In / out $/Mtok
                    </th>
                    <th scope="col" class="py-1 text-right font-medium text-toned">Implied $</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="m in p.models"
                    :key="m.model_permaslug"
                    class="border-b border-default"
                  >
                    <th scope="row" class="py-1 pr-2 text-left font-mono font-normal text-default">
                      {{ m.model_permaslug }}
                    </th>
                    <td class="py-1 pr-2 text-right font-mono text-toned">
                      {{ compactTokens(m.tokens) }}
                    </td>
                    <td class="py-1 pr-2 text-toned">
                      <NuxtLink
                        v-if="m.matched_key && !m.reason"
                        :to="`/prices/${encodeURIComponent(m.matched_key)}`"
                        class="font-mono underline underline-offset-2 hover:text-default"
                        >{{ m.matched_key }}</NuxtLink
                      >
                      <span v-else-if="m.reason === 'unpriced'" :title="m.matched_key ?? ''">
                        listed, no published price
                      </span>
                      <span v-else-if="m.reason === 'free'">OpenRouter free tier</span>
                      <span v-else>no catalog SKU matched</span>
                    </td>
                    <td class="whitespace-nowrap py-1 pr-2 text-right font-mono text-toned">
                      <template v-if="!m.reason">
                        {{ m.input_per_mtok ?? '—' }} / {{ m.output_per_mtok ?? '—' }}
                      </template>
                      <template v-else>—</template>
                    </td>
                    <td class="whitespace-nowrap py-1 text-right font-mono text-default">
                      {{ range(m.spend_low, m.spend_high, compactUsd) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </UCollapsible>

      <p v-if="compact" class="text-sm">
        <NuxtLink to="/rankings#spend" class="text-primary underline underline-offset-2">
          The join per model, and what could not be priced
        </NuxtLink>
      </p>
    </template>

    <!-- Caveat, citation and provenance ship in every state. -->
    <div class="space-y-1 text-xs text-toned">
      <p class="flex flex-wrap items-center gap-x-2">
        <span>Implied OpenRouter-channel spend at list price — not revenue, not market share</span>
        <TerminalCaveatMark name="Full caveat for the implied spend share" :text="spend.caveat" />
      </p>
      <p v-if="spend.rankings.meta.citation">
        <a
          href="https://openrouter.ai/rankings"
          target="_blank"
          rel="noopener noreferrer"
          class="underline underline-offset-2 hover:text-default"
          >{{ spend.rankings.meta.citation }}</a
        >
      </p>
      <p class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <TerminalProvenanceTag
          v-if="spend.rankings.provenance"
          :label="spend.rankings.source.label"
          :source-url="spend.rankings.provenance.source_url"
          :fetched-at="spend.rankings.provenance.fetched_at"
        />
        <TerminalProvenanceTag
          v-for="s in spend.price_sources"
          :key="s.source_id"
          :label="s.label"
          :source-url="s.source_url"
          :fetched-at="s.fetched_at"
        />
      </p>
    </div>
  </div>
</template>
