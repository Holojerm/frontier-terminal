<script setup lang="ts">
// DESIGN.md › Empty states: one line of explanation, at most one action, no
// illustration. `title` says what is absent; `body` says why, because an
// empty panel that cannot explain itself reads as a broken one.

defineProps<{
  title: string
  body?: string
  action?: { label: string; to: string }
}>()
</script>

<template>
  <div class="rounded border border-dashed border-default p-4">
    <p class="text-sm text-default">
      <span class="text-highlighted">{{ title }}</span>
      <template v-if="body"> {{ body }}</template>
    </p>
    <UButton v-if="action" :to="action.to" variant="link" size="sm" class="mt-2 px-0">
      {{ action.label }}
    </UButton>
  </div>
</template>
