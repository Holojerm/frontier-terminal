<script setup lang="ts">
// A stated absence (DESIGN.md › Empty states and gaps). `title` says what is
// missing, `reason` says why, because an empty panel that cannot explain
// itself reads as a broken one. Inline, it sits in the table cell or line
// where the number would have been, the reason behind an info control; as a
// block it is a dashed box with at most one action.

defineProps<{
  title: string
  reason?: string
  inline?: boolean
  /** Accessible name for the inline reason control. */
  name?: string
  action?: { label: string; to: string }
}>()
</script>

<template>
  <span v-if="inline" class="font-sans text-xs text-muted">
    {{ title
    }}<TerminalCaveatMark
      v-if="reason"
      :name="name ?? `Why: ${title}`"
      :text="reason"
      class="ml-1 align-middle"
    />
  </span>
  <div v-else class="rounded border border-dashed border-default p-3 font-sans">
    <p class="text-sm">
      <span class="text-highlighted">{{ title }}</span>
      <span v-if="reason" class="ml-1 text-muted">{{ reason }}</span>
    </p>
    <UButton v-if="action" :to="action.to" variant="link" size="sm" class="mt-1 px-0">
      {{ action.label }}
    </UButton>
  </div>
</template>
