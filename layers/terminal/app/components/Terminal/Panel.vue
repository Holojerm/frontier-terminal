<script setup lang="ts">
// The shell every reading sits in (DESIGN.md › Terminal primitives): a
// bordered box with a header strip — title, one-line note, and a meta slot
// for the panel's own stamp or count — then the body, then a footer for the
// sources and the one link onward. `flush` drops the body padding so a
// table's rows run to the border, the way a terminal grid does.
//
// The note sits on `bg-muted`, so it is `text-toned`: `text-muted` on that
// strip is the light-mode pairing DESIGN.md › Surface and text rules warns of.

defineProps<{
  id: string
  title: string
  note?: string
  /** The one link onward to the fuller reading. */
  more?: { label: string; to: string }
  flush?: boolean
}>()
</script>

<template>
  <section
    :id="id"
    :aria-labelledby="`${id}-heading`"
    class="min-w-0 rounded border border-default"
  >
    <header
      class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-t border-b border-default bg-muted px-3 py-2"
    >
      <div class="min-w-0 space-y-1">
        <h2 :id="`${id}-heading`" class="text-sm text-highlighted">{{ title }}</h2>
        <p v-if="note" class="text-xs text-toned">{{ note }}</p>
      </div>
      <div v-if="$slots.meta" class="text-xs text-toned">
        <slot name="meta" />
      </div>
    </header>

    <div :class="flush ? undefined : 'space-y-3 p-3'">
      <slot />
    </div>

    <footer
      v-if="$slots.foot || more"
      class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-t border-default px-3 py-2"
    >
      <div class="min-w-0 space-y-1 text-xs text-muted">
        <slot name="foot" />
      </div>
      <NuxtLink
        v-if="more"
        :to="more.to"
        class="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-2"
      >
        {{ more.label }}
        <UIcon name="i-lucide-arrow-right" class="size-3.5" aria-hidden="true" />
      </NuxtLink>
    </footer>
  </section>
</template>
