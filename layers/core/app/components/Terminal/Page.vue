<script setup lang="ts">
// Every page's header and its one failure state (DESIGN.md › Terminal primitives).
// The as-of stamp is the payload's own; the error alert never shows a stale number.
// A data page (not `narrow`) ends with the data license.

const stamps = useStamps()

withDefaults(
  defineProps<{
    title?: string
    lede?: string
    asOf?: string | null
    back?: { label: string; to: string }
    error?: boolean
    errorTitle?: string
    errorBody?: string
    /** A prose page: cap the column at reading width. */
    narrow?: boolean
  }>(),
  {
    title: undefined,
    lede: undefined,
    asOf: null,
    back: undefined,
    errorTitle: 'Part of this page didn’t load',
    errorBody: 'One of our data requests failed. We show the panels that loaded.',
  },
)
</script>

<template>
  <div class="space-y-6" :class="narrow ? 'max-w-3xl' : undefined">
    <header class="space-y-2">
      <UButton
        v-if="back"
        :to="back.to"
        variant="link"
        color="neutral"
        size="sm"
        icon="i-lucide-arrow-left"
        class="px-0 text-muted"
      >
        {{ back.label }}
      </UButton>
      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 class="min-w-0 text-2xl text-highlighted">
          <slot name="title">{{ title }}</slot>
        </h1>
        <p v-if="asOf" class="text-xs text-muted">
          as of
          <time :datetime="asOf" :title="exactStamp(asOf)">{{ stamps.absolute(asOf) }}</time>
        </p>
      </div>
      <p v-if="lede || $slots.lede" class="max-w-3xl text-sm text-muted">
        <slot name="lede">{{ lede }}</slot>
      </p>
      <slot name="header" />
    </header>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-database-zap"
      :title="errorTitle"
      :description="errorBody"
    />

    <slot />

    <p v-if="!narrow" class="max-w-3xl text-xs text-muted">
      Data from the last {{ LICENSE_WINDOW_DAYS }} days is {{ DATA_LICENSE.short }}. Older data is
      {{ HISTORY_LICENSE.short }}, except what we published before {{ LICENSE_SPLIT_EFFECTIVE }},
      which stays {{ DATA_LICENSE.short }}.
      <NuxtLink to="/license" class="py-1.5 text-primary underline underline-offset-2"
        >How you can reuse it</NuxtLink
      >.
    </p>
  </div>
</template>
