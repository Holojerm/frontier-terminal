<script setup lang="ts">
// "New SKU listed" events, newest first. Each row is one `added` change on
// a model row: the day it was first seen, the price printed beside it then,
// and the fetch it was read from. The model links to the SKU's own page,
// where later reprices live.

import { money } from '#shared/utils/terminal-format'
import type { ReleaseView } from '#shared/utils/terminal-types'

defineProps<{ rows: ReleaseView[] }>()

const DISPLAY: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  other: 'Other',
}

const priced = (r: ReleaseView) => r.input_per_mtok !== null || r.output_per_mtok !== null
</script>

<template>
  <ol class="divide-y divide-default">
    <li
      v-for="r in rows"
      :key="r.change_id"
      class="grid gap-x-4 gap-y-1 py-3 first:pt-0 sm:grid-cols-[7rem_1fr_auto]"
    >
      <time :datetime="r.first_seen_at" class="text-sm text-toned" :title="r.first_seen_at">
        {{ r.first_seen_at.slice(0, 10) }}
      </time>
      <div class="space-y-1">
        <div class="flex flex-wrap items-center gap-x-2 text-sm">
          <span class="text-muted">{{ DISPLAY[r.provider] ?? r.provider }}</span>
          <NuxtLink
            :to="`/prices/${r.entity_key}`"
            class="font-mono text-highlighted underline underline-offset-2"
          >
            {{ r.model_slug }}
          </NuxtLink>
          <span v-if="r.tier" class="text-xs text-muted">{{ r.tier }}</span>
          <span v-if="r.context_window" class="text-xs text-muted">{{ r.context_window }}</span>
          <TerminalCaveatMark v-if="r.notes" :name="`Notes for ${r.model_slug}`" :text="r.notes" />
          <!-- Optional chaining: a payload cached before this field existed may be served for up to five minutes after a deploy. -->
          <span v-if="r.also_listed_by?.length" class="text-xs text-muted">
            also on {{ r.also_listed_by.join(', ') }}
          </span>
        </div>
        <TerminalProvenanceTag :source-url="r.source_url" :fetched-at="r.fetched_at" />
      </div>
      <div class="font-mono text-sm sm:text-right">
        <template v-if="priced(r)">
          <span class="text-highlighted">{{ money(r.input_per_mtok) }}</span>
          <span class="text-xs text-muted"> in</span>
          <span class="text-default"> {{ money(r.output_per_mtok) }}</span>
          <span class="text-xs text-muted"> out</span>
        </template>
        <span v-else class="text-xs text-muted">catalog only — no price printed</span>
      </div>
    </li>
  </ol>
</template>
