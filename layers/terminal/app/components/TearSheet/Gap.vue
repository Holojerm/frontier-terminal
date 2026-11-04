<script setup lang="ts">
// A stated absence on the sheet, with its reason as text. TerminalGap puts the
// reason behind a popover, which paper can't open.

defineProps<{ title: string; reason?: string | null }>()
</script>

<template>
  <span class="block text-xs">
    <span class="text-highlighted">{{ title }}.</span
    ><span v-if="reason" class="text-muted">{{ ` ${reason}` }}</span>
  </span>
</template>
