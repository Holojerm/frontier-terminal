<script setup lang="ts">
// The ticker: info-tier rows, one line each. What moved, low stakes — so no
// explanation inline and no expandable rows; the headline is the permalink
// and the explanation and cited rows live there. Provenance still travels on
// every line, because a ticker line is a datum too.

import { relativeStamp } from '#shared/utils/terminal-format'
import { alertPath } from '#shared/utils/terminal-tiers'
import type { AlertView } from '#shared/utils/terminal-types'

defineProps<{ alerts: AlertView[] }>()

const now = useNow()
</script>

<template>
  <ol class="divide-y divide-default text-sm">
    <li
      v-for="alert in alerts"
      :id="alert.id"
      :key="alert.id"
      class="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 first:pt-0"
    >
      <time
        :datetime="alert.created_at"
        :title="alert.created_at"
        class="w-20 shrink-0 font-mono text-xs text-toned"
      >
        {{ relativeStamp(alert.created_at, now) }}
      </time>
      <NuxtLink
        :to="alertPath(alert.id)"
        class="min-w-0 flex-1 text-default underline underline-offset-2 decoration-1 hover:text-highlighted"
      >
        {{ alert.headline }}
      </NuxtLink>
      <TerminalProvenanceTag :source-url="alert.source_url" :fetched-at="alert.fetched_at" />
    </li>
  </ol>
</template>
