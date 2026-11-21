<script setup lang="ts">
// The minor changes: info-tier rows, one line each, with no inline explanation; the
// headline is the permalink. Provenance still travels on every line.

import type { AlertView } from '../../../shared/types/alerts'

defineProps<{ alerts: AlertView[] }>()

const stamps = useStamps()
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
        class="w-20 shrink-0 font-mono text-xs text-muted"
      >
        {{ stamps.relative(alert.created_at) }}
      </time>
      <NuxtLink
        :to="alertPath(alert.id)"
        class="min-w-0 flex-1 text-default underline underline-offset-2 decoration-1 hover:text-highlighted"
      >
        {{ readableEdgarNames(alert.headline) }}
      </NuxtLink>
      <TerminalProvenanceTag
        :source-url="alert.source_url"
        :fetched-at="alert.fetched_at"
        compact
      />
    </li>
  </ol>
</template>
