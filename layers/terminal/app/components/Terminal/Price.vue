<script setup lang="ts">
// The in/out price pair, $ per million tokens, as every surface prints it.

import { money } from '../../../shared/utils/terminal-format'

defineProps<{ input: number | null; output: number | null }>()
</script>

<template>
  <span class="whitespace-nowrap font-mono">
    <span class="text-highlighted">{{ money(input) }}</span>
    <span class="text-xs text-muted"> in </span>
    <span class="text-default">{{ money(output) }}</span>
    <span class="text-xs text-muted"> out</span>
  </span>
</template>
