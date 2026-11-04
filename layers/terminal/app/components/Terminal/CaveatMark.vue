<script setup lang="ts">
// A caveat that can actually be read. A `title=` attribute is invisible
// until a hover, untouchable on a phone, unreachable by keyboard, and never
// printed. Trustworthiness is this project's depth axis, so the disclosure
// is a real control: a button that opens the text in a popover on click,
// Enter, Space, or tap, and the text renders in the page.
//
// The trigger is a plain <button> carrying the classes UButton rendered for
// these two variants, not a UButton. /data renders ~240 of these, and each
// UButton (with its ULink and theme proxy) was ~40% of that page's render
// CPU (1.6s on a cache miss in production, 2026-11-04). The popover itself
// is still UPopover, so focus, Escape and aria-expanded are unchanged.

defineProps<{
  text: string
  /** Visible label for the trigger; without one the trigger is the icon alone. */
  label?: string
  /** Accessible name when there is no label. */
  name?: string
}>()

const BASE =
  'rounded-md font-medium inline-flex items-center transition-colors text-xs gap-1.5 outline-inverted/25 focus-visible:outline-3 min-touch'
/** UButton variant="link" color="neutral" size="sm", plus the old px-0 text-toned. */
const LINK = `${BASE} py-1.5 hover:text-default active:text-default px-0 text-toned`
/** UButton variant="ghost" color="neutral" size="sm", icon only. */
const GHOST = `${BASE} p-1.5 text-default hover:bg-elevated active:bg-elevated`
</script>

<template>
  <UPopover mode="click" :ui="{ content: 'max-w-sm' }">
    <button
      type="button"
      :class="label ? LINK : GHOST"
      :aria-label="label ? undefined : (name ?? 'Caveat')"
    >
      <UIcon name="i-lucide-info" class="shrink-0 size-4" />
      <span v-if="label" class="truncate">{{ label }}</span>
    </button>
    <template #content>
      <p class="p-3 text-sm text-default">{{ text }}</p>
    </template>
  </UPopover>
</template>
