<script lang="ts">
// The caveat control every panel uses; the control itself is CaveatPopover.
// This wrapper only defers its hydration until a visitor touches it.
//
// Hydrating every mark's UPopover at load was a long main-thread task on
// pages that carry many: /data renders ~150. The server-rendered button is
// already the right markup, so nothing is lost by leaving it inert until the
// first pointerenter, focus or click, which hydrates that one mark; Vue then
// replays the event, so a first tap still opens it.
//
// Not Nuxt's `<LazyTerminalCaveatPopover hydrate-on-interaction>`: that
// wrapper fetches the component only once hydration starts, so the replayed
// click lands before the popover exists and the first tap does nothing. A
// static import resolves the loader on page load, which makes hydration on
// interaction synchronous.
import { hydrateOnInteraction } from 'vue'
import CaveatPopover from './CaveatPopover.vue'

const DeferredPopover = defineAsyncComponent({
  loader: () => Promise.resolve(CaveatPopover),
  hydrate: hydrateOnInteraction(['pointerenter', 'focus', 'click']),
})
</script>

<script setup lang="ts">
defineProps<{
  text: string
  /** Visible label for the trigger; without one the trigger is the icon alone. */
  label?: string
  /** Accessible name when there is no label. */
  name?: string
}>()
</script>

<template>
  <DeferredPopover :text="text" :label="label" :name="name" />
</template>
