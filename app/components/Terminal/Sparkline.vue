<script setup lang="ts">
// A 12-point-or-fewer trend beside a number: one series, the accent ink,
// an end dot. Decorative by contract — the row's numbers and the SKU page
// carry the values, so the SVG is hidden from assistive tech and the
// observation count beside it is the accessible summary.

const props = defineProps<{ values: (number | null)[] }>()

const W = 72
const H = 20
const PAD = 3

const points = computed(() => {
  const known = props.values.filter((v): v is number => v !== null)
  if (known.length === 0) return []
  const min = Math.min(...known)
  const max = Math.max(...known)
  const n = props.values.length
  return props.values.map((v, i) => {
    if (v === null) return null
    const x = n === 1 ? W / 2 : PAD + (i / (n - 1)) * (W - 2 * PAD)
    const y = max === min ? H / 2 : PAD + (1 - (v - min) / (max - min)) * (H - 2 * PAD)
    return { x, y }
  })
})

const d = computed(() => {
  const parts: string[] = []
  let open = false
  for (const p of points.value) {
    if (!p) {
      open = false
      continue
    }
    parts.push(`${open ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    open = true
  }
  return parts.join(' ')
})

const last = computed(() => {
  for (let i = points.value.length - 1; i >= 0; i--) if (points.value[i]) return points.value[i]!
  return null
})
</script>

<template>
  <svg
    :viewBox="`0 0 ${W} ${H}`"
    :width="W"
    :height="H"
    aria-hidden="true"
    class="inline-block align-middle text-primary"
    fill="none"
    stroke="currentColor"
  >
    <path :d="d" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
    <circle v-if="last" :cx="last.x" :cy="last.y" r="2.5" fill="currentColor" stroke="none" />
  </svg>
</template>
