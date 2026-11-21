<script setup lang="ts">
// One line chart, drawn as inline SVG from the token layer — no chart
// library, no raw color. Up to three series share one y axis (one unit,
// one scale; two measures of different scale get two charts). Series
// colors are the accent, the ink and the muted ink, never a second hue:
// DESIGN.md allows one accent per viewport. A legend names every series
// when there are two or more, and the hover readout lists all of them at
// the nearest x. The chart never gates a value: every page that renders
// one also renders the same numbers as a table.

interface Series {
  id: string
  label: string
  values: (number | null)[]
}

const props = withDefaults(
  defineProps<{
    /** One instant per column, ISO 8601 or YYYY-MM-DD, ascending. */
    x: string[]
    series: Series[]
    /** Step-after: a value holds until the next observation (prices). */
    step?: boolean
    format: (v: number) => string
    /** The y-axis tick text, when it should read shorter than a value (`format` otherwise). */
    tickFormat?: (v: number) => string
    xLabel: (x: string) => string
    /** Accessible name — what is plotted, in one sentence. */
    title: string
    /** A dashed level across the plot, labelled: a claim's kill line. */
    rule?: { value: number; label: string }
    /** A top for the y-axis shared across a grid of charts, so their heights compare. */
    yMax?: number
    /** Drawing height in px; small multiples draw shorter. */
    height?: number
    /** The hover readout's x text, when the axis ticks read shorter (`xLabel` otherwise). */
    pointLabel?: (x: string) => string
  }>(),
  { step: false, height: 220 },
)

// The drawing width is the box's own width in CSS pixels, measured on mount,
// so the chart fills its panel and its 12-unit labels stay 12px at any
// width. A fixed viewBox scaled with the box instead: capped, it left half a
// wide panel empty; uncapped, it set the labels at twice the body size.
const W = useChartWidth('box')
const H = computed(() => props.height)
// 12px labels run about 7 units a character; 8 more is the gap to the line.
const LABEL_CHAR = 7
const END_ROOM = 84
// Room on the right for direct end labels, only when they will be drawn: kept
// for labels too long to fit, it left two-series charts 64px narrower than the card.
const endFits = computed(
  () =>
    props.series.length > 1 &&
    props.series.every((s) => s.label.length * LABEL_CHAR + 8 <= END_ROOM),
)
const PAD = computed(() => ({ l: 56, r: endFits.value ? END_ROOM : 20, t: 12, b: 28 }))

// Series slot → ink. Fixed by position so a filtered series never repaints
// the survivors.
const INK = ['text-primary', 'text-highlighted', 'text-muted'] as const

const times = computed(() => props.x.map((v) => Date.parse(v)))

// The rule counts toward the range: a kill line off the top of the plot is
// the one line a reader most needs to see.
const yMax = computed(() => {
  let max = Math.max(0, props.yMax ?? 0, props.rule?.value ?? 0)
  for (const s of props.series) for (const v of s.values) if (v !== null && v > max) max = v
  return niceCeil(max)
})

// Zero unless a value is negative (a loss), so the axis still starts at zero.
const yMin = computed(() => {
  let min = Math.min(0, props.rule?.value ?? 0)
  for (const s of props.series) for (const v of s.values) if (v !== null && v < min) min = v
  return min < 0 ? -niceCeil(-min) : 0
})

/** Round up to 1, 2, 2.5 or 5 × a power of ten, so ticks are clean. */
function niceCeil(v: number): number {
  if (v <= 0) return 1
  const exp = Math.floor(Math.log10(v))
  const base = 10 ** exp
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * base) return m * base
  return 10 * base
}

const xAt = (i: number): number => {
  const t0 = times.value[0] ?? 0
  const t1 = times.value.at(-1) ?? t0
  const span = t1 - t0
  const inner = W.value - PAD.value.l - PAD.value.r
  if (span <= 0) return PAD.value.l + inner / 2
  return PAD.value.l + ((times.value[i]! - t0) / span) * inner
}
const yAt = (v: number): number =>
  PAD.value.t +
  (1 - (v - yMin.value) / (yMax.value - yMin.value)) * (H.value - PAD.value.t - PAD.value.b)

const yTicks = computed(() =>
  [0, 0.25, 0.5, 0.75, 1].map((f) => yMin.value + f * (yMax.value - yMin.value)),
)

/** Up to five x labels, evenly spread over the columns. */
const xTicks = computed(() => {
  const n = props.x.length
  if (n === 0) return []
  const want = Math.min(5, n)
  // Evenly spaced in time, not in index: an irregular series (weekly archive
  // copies with months between some) would otherwise bunch its labels.
  const t = times.value
  const span = t[n - 1]! - t[0]!
  const idx = new Set<number>()
  for (let k = 0; k < want; k++) {
    const target = t[0]! + (k * span) / Math.max(1, want - 1)
    let best = 0
    for (let i = 1; i < n; i++) if (Math.abs(t[i]! - target) < Math.abs(t[best]! - target)) best = i
    idx.add(best)
  }
  // A centred label at either end ran past the box ("Sep '2"): those anchor
  // to their own edge instead.
  return [...idx].map((i) => {
    const x = xAt(i)
    const label = props.xLabel(props.x[i]!)
    const half = (label.length * LABEL_CHAR) / 2
    const anchor = x + half > W.value ? 'end' : x - half < 0 ? 'start' : 'middle'
    return { i, x, label, anchor }
  })
})

/** SVG path per series; a null breaks the line rather than bridging it. */
function pathOf(values: (number | null)[]): string {
  const parts: string[] = []
  let open = false
  let prev: number | null = null
  values.forEach((v, i) => {
    if (v === null) {
      open = false
      prev = null
      return
    }
    const px = xAt(i).toFixed(1)
    const py = yAt(v).toFixed(1)
    if (!open) {
      parts.push(`M${px} ${py}`)
      open = true
    } else if (props.step && prev !== null) {
      parts.push(`H${px} V${py}`)
    } else {
      parts.push(`L${px} ${py}`)
    }
    prev = v
  })
  return parts.join(' ')
}

const paths = computed(() => props.series.map((s) => pathOf(s.values)))

const lastPoint = (s: Series) => {
  for (let i = s.values.length - 1; i >= 0; i--) {
    const v = s.values[i]
    if (v !== null && v !== undefined) return { x: xAt(i), y: yAt(v) }
  }
  return null
}

// Direct end labels ride the lines when they fit and do not collide; otherwise
// the legend and the readout carry identity (dataviz: never nudge labels
// apart, never clip them). A single line needs none: the title names it.
const endLabels = computed(() => {
  if (!endFits.value) return []
  const ends = props.series.map((s) => ({ label: s.label, at: lastPoint(s) }))
  const ys = ends.map((e) => e.at?.y ?? null).filter((y): y is number => y !== null)
  for (let a = 0; a < ys.length; a++) {
    for (let b = a + 1; b < ys.length; b++) if (Math.abs(ys[a]! - ys[b]!) < 16) return []
  }
  return ends
})

// ---- hover readout ---------------------------------------------------------

const svg = ref<SVGSVGElement | null>(null)
const hover = ref<number | null>(null)

function onMove(e: PointerEvent) {
  const el = svg.value
  if (!el || props.x.length === 0) return
  const rect = el.getBoundingClientRect()
  const px = ((e.clientX - rect.left) / rect.width) * W.value
  let best = 0
  let dist = Infinity
  for (let i = 0; i < props.x.length; i++) {
    const d = Math.abs(xAt(i) - px)
    if (d < dist) {
      dist = d
      best = i
    }
  }
  hover.value = best
}

const readout = computed(() => {
  const i = hover.value
  if (i === null) return null
  return {
    x: xAt(i),
    left: `${((xAt(i) / W.value) * 100).toFixed(1)}%`,
    flip: xAt(i) / W.value > 0.6,
    label: (props.pointLabel ?? props.xLabel)(props.x[i]!),
    rows: props.series.map((s, k) => ({
      ink: INK[k] ?? INK[2],
      label: s.label,
      value: s.values[i] ?? null,
    })),
  }
})
</script>

<template>
  <figure class="space-y-2">
    <figcaption v-if="series.length > 1" class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-toned">
      <span v-for="(s, k) in series" :key="s.id" class="inline-flex items-center gap-1.5">
        <span :class="INK[k] ?? INK[2]" aria-hidden="true">
          <svg width="16" height="6" viewBox="0 0 16 6" class="block">
            <line x1="0" y1="3" x2="16" y2="3" stroke="currentColor" stroke-width="2" />
          </svg>
        </span>
        {{ s.label }}
      </span>
    </figcaption>

    <div ref="box" class="relative">
      <svg
        ref="svg"
        :viewBox="`0 0 ${W} ${H}`"
        :height="H"
        preserveAspectRatio="xMinYMid meet"
        class="block w-full"
        role="img"
        :aria-label="title"
        @pointermove="onMove"
        @pointerleave="hover = null"
      >
        <!-- Grid and axes: solid hairlines one step off the surface. -->
        <g class="stroke-(--ui-border)" stroke-width="1">
          <line
            v-for="t in yTicks"
            :key="t"
            :x1="PAD.l"
            :x2="W - PAD.r"
            :y1="yAt(t)"
            :y2="yAt(t)"
          />
        </g>
        <g class="fill-(--ui-text-muted) font-mono tabular-nums" font-size="12">
          <text v-for="t in yTicks" :key="t" :x="PAD.l - 6" :y="yAt(t) + 4" text-anchor="end">
            {{ (tickFormat ?? format)(t) }}
          </text>
          <text v-for="t in xTicks" :key="t.i" :x="t.x" :y="H - 8" :text-anchor="t.anchor">
            {{ t.label }}
          </text>
        </g>

        <!-- The rule: dashed, named in words, so it never reads by color alone.
             The name sits below the line (a claim that holds runs above it)
             and wears a halo of the surface, so a series crossing it can't
             strike it through. -->
        <g v-if="rule" class="stroke-(--ui-error) fill-(--ui-error)">
          <line
            :x1="PAD.l"
            :x2="W - PAD.r"
            :y1="yAt(rule.value)"
            :y2="yAt(rule.value)"
            stroke-width="1.5"
            stroke-dasharray="6 4"
          />
          <text
            :x="PAD.l + 4"
            :y="yAt(rule.value) + 16 > H - PAD.b ? yAt(rule.value) - 6 : yAt(rule.value) + 16"
            font-size="12"
            class="stroke-(--ui-bg)"
            stroke-width="4"
            stroke-linejoin="round"
            paint-order="stroke"
          >
            {{ rule.label }}
          </text>
        </g>

        <!-- Crosshair at the nearest column. -->
        <line
          v-if="readout"
          :x1="readout.x"
          :x2="readout.x"
          :y1="PAD.t"
          :y2="H - PAD.b"
          class="stroke-(--ui-text-dimmed)"
          stroke-width="1"
        />

        <!-- Series: 2px round-joined lines, an 8px end dot with a surface ring. -->
        <g
          v-for="(s, k) in series"
          :key="s.id"
          :class="INK[k] ?? INK[2]"
          fill="none"
          stroke="currentColor"
        >
          <path :d="paths[k]" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
          <template v-if="lastPoint(s)">
            <circle
              :cx="lastPoint(s)!.x"
              :cy="lastPoint(s)!.y"
              r="6"
              class="fill-(--ui-bg)"
              stroke="none"
            />
            <circle
              :cx="lastPoint(s)!.x"
              :cy="lastPoint(s)!.y"
              r="4"
              fill="currentColor"
              stroke="none"
            />
          </template>
          <template v-if="readout && s.values[hover!] !== null && s.values[hover!] !== undefined">
            <circle
              :cx="readout.x"
              :cy="yAt(s.values[hover!]!)"
              r="6"
              class="fill-(--ui-bg)"
              stroke="none"
            />
            <circle
              :cx="readout.x"
              :cy="yAt(s.values[hover!]!)"
              r="4"
              fill="currentColor"
              stroke="none"
            />
          </template>
        </g>

        <g class="fill-(--ui-text-toned)" font-size="12">
          <text
            v-for="e in endLabels"
            :key="e.label"
            :x="(e.at?.x ?? 0) + 8"
            :y="(e.at?.y ?? 0) + 4"
          >
            {{ e.label }}
          </text>
        </g>
      </svg>

      <!-- Readout: values lead, series names follow. Hover-only by design; the
           page's table is the keyboard-reachable twin. -->
      <div
        v-if="readout"
        aria-hidden="true"
        class="pointer-events-none absolute top-2 rounded border border-default bg-elevated px-3 py-2 text-xs shadow-sm"
        :class="readout.flip ? '-translate-x-full' : ''"
        :style="{ left: readout.left, marginLeft: readout.flip ? '-8px' : '8px' }"
      >
        <p class="text-toned">{{ readout.label }}</p>
        <p v-for="r in readout.rows" :key="r.label" class="flex items-center gap-2">
          <span :class="r.ink" aria-hidden="true">
            <svg width="12" height="4" viewBox="0 0 12 4" class="block">
              <line x1="0" y1="2" x2="12" y2="2" stroke="currentColor" stroke-width="2" />
            </svg>
          </span>
          <span class="font-mono text-highlighted">{{
            r.value === null ? '—' : format(r.value)
          }}</span>
          <span class="text-toned">{{ r.label }}</span>
        </p>
      </div>
    </div>
  </figure>
</template>
