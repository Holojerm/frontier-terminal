<script setup lang="ts">
// The 30-day series as stacked columns, one per UTC day, segments per lab
// with "other" on top. Inline SVG from DESIGN.md tokens: every fill is
// currentColor under a semantic text class, one accent hue in opacity steps
// (one accent per viewport), 2px surface gaps between segments, a legend
// always, and a table view of the same numbers so nothing rests on the
// picture alone.

import { compactTokens } from '#shared/utils/terminal-format'
import type { ProviderId, RankingDay } from '#shared/utils/terminal-types'

const props = defineProps<{ series: RankingDay[] }>()

const STACK: { id: ProviderId; label: string; cls: string; opacity: number; swatch: string }[] = [
  { id: 'openai', label: 'OpenAI', cls: 'text-primary', opacity: 1, swatch: 'bg-primary' },
  {
    id: 'anthropic',
    label: 'Anthropic',
    cls: 'text-primary',
    opacity: 0.7,
    swatch: 'bg-primary opacity-70',
  },
  {
    id: 'google',
    label: 'Google',
    cls: 'text-primary',
    opacity: 0.45,
    swatch: 'bg-primary opacity-45',
  },
  { id: 'xai', label: 'xAI', cls: 'text-primary', opacity: 0.25, swatch: 'bg-primary opacity-25' },
  { id: 'other', label: 'Other', cls: 'text-dimmed', opacity: 0.6, swatch: 'bg-accented' },
]

const W = 720
const H = 240
const PAD = { top: 8, right: 8, bottom: 24, left: 44 }
const plotW = W - PAD.left - PAD.right
const plotH = H - PAD.top - PAD.bottom
const GAP = 2

/** Axis ceiling on a 1 / 2 / 2.5 / 5 step so ticks land on clean numbers. */
function niceCeil(max: number): number {
  if (max <= 0) return 1
  const exp = 10 ** Math.floor(Math.log10(max))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= max) return m * exp
  return 10 * exp
}

const yMax = computed(() => niceCeil(Math.max(0, ...props.series.map((d) => d.total))))
const ticks = computed(() => [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax.value))
const y = (v: number) => PAD.top + plotH - (v / yMax.value) * plotH

const slot = computed(() => (props.series.length ? plotW / props.series.length : plotW))
const barW = computed(() => Math.min(24, Math.max(4, slot.value - 4)))
const x = (i: number) => PAD.left + i * slot.value + (slot.value - barW.value) / 2

interface Segment {
  id: ProviderId
  cls: string
  opacity: number
  x: number
  y: number
  h: number
}

const columns = computed(() =>
  props.series.map((day, i) => {
    let acc = 0
    const segments: Segment[] = []
    for (const s of STACK) {
      const v = day.tokens[s.id]
      if (v <= 0) continue
      const top = y(acc + v)
      const bottom = y(acc)
      acc += v
      // The 2px gap is taken from the segment's own top so the stack still
      // ends exactly at the day's total.
      const h = Math.max(0, bottom - top - (segments.length ? GAP : 0))
      segments.push({ id: s.id, cls: s.cls, opacity: s.opacity, x: x(i), y: bottom - h, h })
    }
    return { day, segments }
  }),
)

const labelEvery = computed(() => (props.series.length > 12 ? 5 : props.series.length > 6 ? 2 : 1))
const xLabels = computed(() =>
  props.series
    .map((d, i) => ({ text: d.date.slice(5), x: x(i) + barW.value / 2, i }))
    .filter(({ i }) => i % labelEvery.value === 0 || i === props.series.length - 1),
)

const describe = (day: RankingDay) =>
  `${day.date}: ${STACK.map((s) => `${s.label} ${compactTokens(day.tokens[s.id])}`).join(', ')} — total ${compactTokens(day.total)}`

const uid = useId()
</script>

<template>
  <div class="space-y-3">
    <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-toned" aria-label="Legend">
      <li v-for="s in STACK" :key="s.id" class="flex items-center gap-1.5">
        <span class="inline-block size-3 rounded-sm" :class="s.swatch" aria-hidden="true" />
        {{ s.label }}
      </li>
    </ul>

    <svg
      :viewBox="`0 0 ${W} ${H}`"
      class="w-full"
      role="img"
      :aria-labelledby="`${uid}-title`"
      :aria-describedby="`${uid}-desc`"
    >
      <title :id="`${uid}-title`">Tokens routed per UTC day, stacked by lab</title>
      <desc :id="`${uid}-desc`">
        {{ series.length }} days; the table below carries every value.
      </desc>

      <!-- gridlines: hairline, recessive -->
      <g class="stroke-current text-muted" stroke-width="1" stroke-opacity="0.35">
        <line
          v-for="t in ticks"
          :key="t"
          :x1="PAD.left"
          :x2="W - PAD.right"
          :y1="y(t)"
          :y2="y(t)"
        />
      </g>
      <g class="fill-current text-toned" font-size="10" text-anchor="end">
        <text v-for="t in ticks" :key="t" :x="PAD.left - 6" :y="y(t) + 3">
          {{ compactTokens(t) }}
        </text>
      </g>

      <g v-for="col in columns" :key="col.day.date">
        <title>{{ describe(col.day) }}</title>
        <rect
          v-for="seg in col.segments"
          :key="seg.id"
          :x="seg.x"
          :y="seg.y"
          :width="barW"
          :height="seg.h"
          :fill-opacity="seg.opacity"
          class="fill-current"
          :class="seg.cls"
        />
      </g>

      <g class="fill-current text-toned" font-size="10" text-anchor="middle">
        <text v-for="l in xLabels" :key="l.i" :x="l.x" :y="H - 8">{{ l.text }}</text>
      </g>
    </svg>

    <details class="text-sm">
      <summary class="cursor-pointer text-toned">Table view</summary>
      <div class="mt-2 overflow-x-auto">
        <table class="w-full text-xs">
          <caption class="sr-only">
            Tokens routed per UTC day by lab
          </caption>
          <thead>
            <tr class="border-b border-default text-left">
              <th scope="col" class="py-1 pr-3 font-medium text-muted">Date</th>
              <th
                v-for="s in STACK"
                :key="s.id"
                scope="col"
                class="py-1 pr-3 text-right font-medium text-muted"
              >
                {{ s.label }}
              </th>
              <th scope="col" class="py-1 text-right font-medium text-muted">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in series" :key="d.date" class="border-b border-default">
              <th scope="row" class="py-1 pr-3 text-left font-mono font-normal">{{ d.date }}</th>
              <td v-for="s in STACK" :key="s.id" class="py-1 pr-3 text-right font-mono">
                {{ compactTokens(d.tokens[s.id]) }}
              </td>
              <td class="py-1 text-right font-mono">{{ compactTokens(d.total) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </div>
</template>
