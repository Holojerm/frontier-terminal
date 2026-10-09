<script setup lang="ts">
// A claim's status as a word, an icon and a color — never the color alone.

import { STATUS_META } from '#shared/utils/thesis-format'
import type { ClaimStatus } from '#shared/utils/thesis-types'

defineProps<{ status: ClaimStatus; size?: 'sm' | 'md'; count?: number }>()
</script>

<template>
  <UBadge
    :color="STATUS_META[status].color"
    variant="subtle"
    :size="size ?? 'md'"
    :icon="STATUS_META[status].icon"
  >
    {{ count === undefined ? '' : `${count} ` }}{{ STATUS_META[status].label }}
  </UBadge>
</template>
