<script lang="ts">
// Defers CaveatPopover's hydration until a visitor touches the mark: hydrating every
// UPopover at load was a long main-thread task on /data. Vue replays the event, so
// a first tap still opens it. Not `<LazyTerminalCaveatPopover hydrate-on-interaction>`:
// that fetches the component only once hydration starts, so the replayed click
// lands before the popover exists. A static import keeps hydration synchronous.
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
