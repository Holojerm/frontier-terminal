<script setup lang="ts">
// Implied spend share: the demand-share tokens joined to each vendor's
// list prices. Rendered as a range per lab (every token at the input price
// to every token at the output price), beside the token share it was
// derived from, with the join's coverage on every row and the labs it
// could not price named rather than shown at zero. Third-party channel,
// list price, disclosed as both.

import { compactTokens, compactUsd, sharePct } from '../../../shared/utils/terminal-format'
import type { SpendData, SpendModel, SpendProviderView } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

const props = defineProps<{
  spend: SpendData
  /** On the landing page: the rows only, no per-model join or coverage column. */
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

const priced = (p: SpendProviderView) => p.priced_tokens > 0

const columns = computed<TableColumn[]>(() => [
  { key: 'display', label: 'Lab' },
  { key: 'share', label: 'Share of lab spend' },
  { key: 'dollars', label: 'Implied $', numeric: true },
  { key: 'tokens', label: 'Share of lab tokens', numeric: true, class: 'text-muted' },
  ...(props.compact
    ? []
    : [{ key: 'coverage', label: 'Priced', numeric: true, class: 'text-muted' }]),
])

const JOIN_COLUMNS: TableColumn[] = [
  { key: 'model_permaslug', label: 'OpenRouter model', class: 'font-mono' },
  { key: 'tokens', label: 'Tokens', numeric: true },
  { key: 'sku', label: 'Catalog SKU' },
  { key: 'prices', label: 'In / out $/Mtok', numeric: true },
  { key: 'implied', label: 'Implied $', numeric: true },
]

const joined = computed(() => props.spend.providers.filter((p) => p.models.length))

const skuText = (m: SpendModel) =>
  m.reason === 'unpriced'
    ? 'listed, no published price'
    : m.reason === 'free'
      ? 'OpenRouter free tier'
      : 'no catalog SKU matched'
</script>

<template>
  <div class="space-y-3">
    <TerminalGap
      v-if="spend.status === 'not_configured'"
      title="Not configured."
      reason="This needs the OpenRouter rankings, which need NUXT_OPENROUTER_API_KEY. We don’t fetch them without one."
    />
    <TerminalGap
      v-else-if="spend.status === 'no_rows'"
      title="No rankings data yet."
      reason="We haven’t fetched the rankings successfully yet."
    />

    <template v-else>
      <p v-if="spend.window" class="text-xs text-muted">
        {{ spend.window.from }} → {{ spend.window.to }} · estimated at list prices
      </p>

      <TerminalTable
        caption="Each lab’s implied spend through OpenRouter as a range and as a share of the tracked labs’ total, with its token share and how much of it we could price"
        :columns="columns"
        :rows="spend.providers"
        :row-key="(p) => p.provider"
        :edge="false"
      >
        <template #cell-display="{ row: p }">
          <span class="text-default">{{ p.display }}</span>
        </template>
        <template #cell-share="{ row: p }">
          <span v-if="priced(p)" class="flex items-center gap-2">
            <span class="w-24 shrink-0"><TerminalBar :value="p.share_high" :max="widest" /></span>
            <span class="whitespace-nowrap font-mono text-highlighted">
              {{ range(p.share_low, p.share_high, sharePct) }}
            </span>
          </span>
          <TerminalGap v-else inline title="Not priceable" />
        </template>
        <template #cell-dollars="{ row: p }">
          {{ priced(p) ? range(p.spend_low, p.spend_high, compactUsd) : '—' }}
        </template>
        <template #cell-tokens="{ row: p }">
          {{ sharePct(p.token_share) }} · {{ compactTokens(p.tokens) }}
        </template>
        <template #cell-coverage="{ row: p }">{{ sharePct(p.coverage) }}</template>
      </TerminalTable>

      <p
        v-if="spend.excluded.length"
        class="flex flex-wrap items-center gap-x-1 text-xs text-muted"
      >
        Left out of the dollar share because we can’t price them:
        {{ spend.excluded.map((e) => e.display).join(', ') }}
        <TerminalCaveatMark
          name="Why some labs are left out of the dollar share"
          :text="spend.excluded.map((e) => `${e.display}: ${e.reason}.`).join(' ')"
        />
      </p>

      <p class="text-xs text-muted">
        {{ compactTokens(spend.totals.other_tokens) }} of
        {{ compactTokens(spend.totals.tokens) }} tokens went to models outside the six labs and are
        not priced.
      </p>

      <TerminalExpand
        v-if="!compact && joined.length"
        show="Show the per-model breakdown"
        hide="Hide the per-model breakdown"
      >
        <div class="space-y-4">
          <div v-for="p in joined" :key="p.provider" class="space-y-1">
            <h3 class="text-sm text-highlighted">{{ p.display }}</h3>
            <TerminalTable
              :caption="`${p.display} ranked models matched to catalog SKUs`"
              :columns="JOIN_COLUMNS"
              :rows="p.models"
              :row-key="(m) => m.model_permaslug"
              nested
            >
              <template #cell-tokens="{ row: m }">{{ compactTokens(m.tokens) }}</template>
              <template #cell-sku="{ row: m }">
                <NuxtLink
                  v-if="m.matched_key && !m.reason"
                  :to="`/prices/${encodeURIComponent(m.matched_key)}`"
                  class="font-mono underline underline-offset-2 hover:text-highlighted"
                  >{{ m.matched_key }}</NuxtLink
                >
                <span v-else class="text-muted" :title="m.matched_key ?? ''">{{ skuText(m) }}</span>
              </template>
              <template #cell-prices="{ row: m }">
                <template v-if="!m.reason">
                  {{ m.input_per_mtok ?? '—' }} / {{ m.output_per_mtok ?? '—' }}
                </template>
                <template v-else>—</template>
              </template>
              <template #cell-implied="{ row: m }">
                {{ range(m.spend_low, m.spend_high, compactUsd) }}
              </template>
            </TerminalTable>
          </div>
        </div>
      </TerminalExpand>
    </template>

    <!-- Caveat, citation and provenance ship in every state. -->
    <TerminalSources
      :sources="[
        ...(spend.rankings.provenance
          ? [{ label: spend.rankings.source.label, ...spend.rankings.provenance }]
          : []),
        ...spend.price_sources,
      ]"
      :caveats="[{ label: 'Not revenue or market share', text: spend.caveat }]"
    >
      <a
        v-if="spend.rankings.meta.citation"
        href="https://openrouter.ai/rankings"
        target="_blank"
        rel="noopener noreferrer"
        class="underline underline-offset-2 hover:text-default"
        :title="spend.rankings.meta.citation"
        >CC BY 4.0</a
      >
    </TerminalSources>
  </div>
</template>
