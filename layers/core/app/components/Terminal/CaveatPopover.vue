<script setup lang="ts">
// A caveat that can be read: a `title=` is invisible until hover, untouchable on a
// phone and unreachable by keyboard, so this is a button opening a popover. The
// trigger is a plain <button> with UButton's classes, since UButton cost ~40% of
// /data's render CPU across its ~240 marks. Render it through TerminalCaveatMark,
// which defers hydration.

defineProps<{
  text: string
  /** Visible label for the trigger; without one the trigger is the icon alone. */
  label?: string
  /** Accessible name when there is no label. */
  name?: string
}>()

const BASE =
  'rounded-md font-medium inline-flex items-center transition-colors text-xs gap-1.5 outline-inverted/25 focus-visible:outline-3 min-touch'
/** UButton variant="link" color="neutral" size="sm", plus px-0 text-toned. */
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
