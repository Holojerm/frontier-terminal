<script setup lang="ts">
// Each lab's most-routed models in the share window. The slug is OpenRouter's
// permaslug verbatim — a variant ranks as its own row there, so it does here.

import { compactTokens, sharePct } from '#shared/utils/terminal-format'
import type { ProviderTopModels } from '#shared/utils/terminal-types'

defineProps<{ providers: ProviderTopModels[] }>()
</script>

<template>
  <div class="grid gap-4 md:grid-cols-2">
    <article
      v-for="p in providers"
      :key="p.provider"
      :aria-labelledby="`top-${p.provider}`"
      class="space-y-3 rounded border border-default bg-elevated p-4"
    >
      <h3 :id="`top-${p.provider}`" class="text-lg text-highlighted">{{ p.display }}</h3>
      <TerminalEmptyState
        v-if="p.models.length === 0"
        title="No models in the window."
        body="None of this lab’s models made OpenRouter’s daily top 50 on these days."
      />
      <ol v-else class="space-y-1">
        <li
          v-for="m in p.models"
          :key="m.model_permaslug"
          class="grid grid-cols-[1fr_auto_auto] items-baseline gap-3 text-xs"
        >
          <span class="truncate font-mono text-default" :title="m.model_permaslug">
            {{ m.model_permaslug }}
          </span>
          <span class="font-mono text-highlighted">{{ compactTokens(m.tokens) }}</span>
          <span class="font-mono text-toned" title="share of this lab’s window tokens">
            {{ sharePct(m.share_of_provider) }}
          </span>
        </li>
      </ol>
      <TerminalProvenanceTag
        v-if="p.models[0]"
        :source-url="p.models[0].source_url"
        :fetched-at="p.models[0].fetched_at"
      />
    </article>
  </div>
</template>
