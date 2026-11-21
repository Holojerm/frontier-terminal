<script setup lang="ts">
// The minor changes as one line: how many, linked to the full list, and the newest of
// them. Where a panel lists alerts, this is all it says about the info tier.

import type { AlertView } from '../../../shared/types/alerts'

defineProps<{
  count: number
  /** The full list this count is of. */
  to: string
  newest?: Pick<AlertView, 'id' | 'headline' | 'created_at'> | null
}>()

const stamps = useStamps()
</script>

<template>
  <p class="flex flex-wrap items-baseline gap-x-2 text-sm text-muted">
    <NuxtLink :to="to" class="whitespace-nowrap underline underline-offset-2 hover:text-default">
      {{ INFO_TIER_LABEL }} · {{ count }}
    </NuxtLink>
    <span v-if="newest" class="min-w-0 truncate">
      <time :datetime="newest.created_at" class="font-mono text-xs">
        {{ stamps.relative(newest.created_at) }}
      </time>
      <NuxtLink :to="alertPath(newest.id)" :title="newest.headline" class="ml-2 hover:text-default">
        {{ readableEdgarNames(newest.headline) }}
      </NuxtLink>
    </span>
  </p>
</template>
