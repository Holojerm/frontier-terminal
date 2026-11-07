<script setup lang="ts">
// Each lab's most-routed models in the share window. The slug is OpenRouter's
// permaslug verbatim — a variant ranks as its own row there, so it does here.

import { sharePct } from '../../../shared/utils/terminal-format'
import type { ProviderTopModels } from '../../../shared/utils/terminal-types'
import type { TableColumn } from '../../types/terminal-ui'

const watchlist = useWatchlist()

const figures = useFigures()

defineProps<{ providers: ProviderTopModels[] }>()

const COLUMNS: TableColumn[] = [
  { key: 'model_permaslug', label: 'Model', class: 'max-w-64 truncate' },
  { key: 'tokens', label: 'Tokens', numeric: true },
  { key: 'share', label: 'Of lab', numeric: true, class: 'text-muted' },
]
</script>

<template>
  <!-- Tiled by the panel's width, not the screen's: the same cards sit in a
       full-width panel on Demand and a narrow one on a lab page. -->
  <div class="@container">
    <div
      class="grid gap-3"
      :class="providers.length > 1 ? '@2xl:grid-cols-2 @5xl:grid-cols-3' : undefined"
    >
      <TerminalCard
        v-for="p in watchlist.first(providers, (p) => p.provider)"
        :id="`top-${p.provider}`"
        :key="p.provider"
        :title="p.display"
        :sources="p.models[0] ? [p.models[0]] : []"
      >
        <TerminalGap
          v-if="p.models.length === 0"
          inline
          title="No ranked models in the window."
          reason="None placed in OpenRouter’s daily top 50 on these days."
        />
        <TerminalTable
          v-else
          :caption="`${p.display} most-routed models, tokens and share of the lab’s own total`"
          :columns="COLUMNS"
          :rows="p.models"
          :row-key="(m) => m.model_permaslug"
          nested
        >
          <template #cell-model_permaslug="{ row: m }">
            <span class="font-mono text-default" :title="m.model_permaslug">{{
              m.model_permaslug
            }}</span>
          </template>
          <template #cell-tokens="{ row: m }">
            <span class="text-highlighted">{{ figures.tokens(m.tokens) }}</span>
          </template>
          <template #cell-share="{ row: m }">{{ sharePct(m.share_of_provider) }}</template>
        </TerminalTable>
      </TerminalCard>
    </div>
  </div>
</template>
