<script setup lang="ts">
// A share bar (DESIGN.md › Terminal primitives): one track, one fill, scaled
// to the widest value in its set. Decorative by contract — the number beside
// it is the reading — so it is hidden from assistive tech. One hue: identity
// is the row label, never the color.

const props = defineProps<{
  value: number | null
  max: number
  /** `neutral` for the residual row ("other"), so it never reads as a lab. */
  tone?: 'primary' | 'neutral'
}>()

const width = computed(() =>
  props.max > 0 && props.value !== null
    ? `${Math.max(1, Math.round((props.value / props.max) * 100))}%`
    : '0%',
)
</script>

<template>
  <span class="block h-2 w-full overflow-hidden rounded bg-muted" aria-hidden="true">
    <span
      class="block h-full"
      :class="tone === 'neutral' ? 'bg-accented' : 'bg-primary'"
      :style="{ width }"
    />
  </span>
</template>
