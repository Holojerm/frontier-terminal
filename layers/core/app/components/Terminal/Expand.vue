<script setup lang="ts">
// The full table behind a reading, one click away and closed by default: the
// daily series under a chart, the per-model join under a share. The content
// stays in the document when open, where find-in-page reaches it.

defineProps<{ show: string; hide: string }>()

const open = ref(false)
</script>

<template>
  <UCollapsible v-model:open="open" class="space-y-2">
    <UButton
      variant="link"
      color="neutral"
      size="sm"
      trailing-icon="i-lucide-chevron-down"
      class="px-0 text-muted"
      :label="open ? hide : show"
    />
    <template #content>
      <slot />
    </template>
  </UCollapsible>
</template>
