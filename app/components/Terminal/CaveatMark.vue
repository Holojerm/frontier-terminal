<script setup lang="ts">
// A caveat that can actually be read. A `title=` attribute is invisible
// until a hover, untouchable on a phone, unreachable by keyboard, and never
// printed. Trustworthiness is this project's depth axis, so the disclosure
// is a real control: a button that opens the text in a popover on click,
// Enter, Space, or tap, and the text renders in the page.

defineProps<{
  text: string
  /** Visible label for the trigger; without one the trigger is the icon alone. */
  label?: string
  /** Accessible name when there is no label. */
  name?: string
}>()
</script>

<template>
  <UPopover mode="click" :ui="{ content: 'max-w-sm' }">
    <UButton
      v-if="label"
      variant="link"
      color="neutral"
      size="sm"
      icon="i-lucide-info"
      :label="label"
      class="min-touch px-0 text-toned"
    />
    <UButton
      v-else
      variant="ghost"
      color="neutral"
      size="sm"
      icon="i-lucide-info"
      :aria-label="name ?? 'Caveat'"
      class="min-touch"
    />
    <template #content>
      <p class="p-3 text-sm text-default">{{ text }}</p>
    </template>
  </UPopover>
</template>
