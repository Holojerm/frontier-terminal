<script setup lang="ts" generic="T">
// The one table (DESIGN.md › Component behavior › Tables). Semantic where
// UTable cannot be: the first column is a row header, and a row whose source
// has nothing to show keeps its label and its `keep` columns (the source,
// usually) and states the gap in one cell spanning the rest — never a run of
// dashes that reads as zeros.
//
// The row header is the first column unless `rowHeader` names another — the
// headline of an alert row, say, where the time column leads.
//
// Cells render `row[key]` unless a `#cell-<key>` slot is given. `nested` is
// the smaller form for a table inside a card: `text-xs`, tighter rows, no
// outer inset.
//
// A table scrolls in its own box, never the page: the box is capped at 70% of
// the viewport, the header sticks to the top of the box, and a wide table
// scrolls sideways inside it. A box that does scroll is a named, focusable
// region so a keyboard can scroll it (WCAG 2.1.1; axe scrollable-region-focusable).

import type { TableColumn } from '../../types/terminal-ui'

const props = withDefaults(
  defineProps<{
    caption: string
    columns: TableColumn[]
    rows: T[]
    rowKey: (row: T) => string
    /** True when the row states a gap instead of figures; the `#gap` slot fills it. */
    gap?: (row: T) => boolean
    /** Which columns the gap cell replaces, when not all but the first and the kept ones. */
    gapColumns?: string[]
    rowId?: (row: T) => string | undefined
    rowClass?: (row: T) => string | undefined
    nested?: boolean
    /**
     * Pad the outer cells (default). A table in a `flush` panel runs to the
     * border and needs the inset; one inside a padded body already has it.
     */
    edge?: boolean
    /** Which column names the row (`<th scope="row">`); the first by default. */
    rowHeader?: string
    /** `top` for rows whose cells wrap to several lines. */
    align?: 'baseline' | 'top'
  }>(),
  // Vue casts an absent boolean prop to false; `edge` reads absent as true.
  { edge: true },
)

defineSlots<
  {
    [K in `cell-${string}`]?: (p: { row: T; index: number }) => unknown
  } & {
    gap?: (p: { row: T }) => unknown
  }
>()

/** The contiguous columns a gap row replaces: `gapColumns`, else every column but the first and the `keep` ones. */
const gapKeys = computed(
  () =>
    props.gapColumns ??
    props.columns
      .slice(1)
      .filter((c) => !c.keep)
      .map((c) => c.key),
)

const pad = computed(() =>
  props.nested
    ? 'px-2 py-1 first:pl-0 last:pr-0'
    : props.edge === false
      ? 'px-3 py-2 first:pl-0 last:pr-0'
      : 'px-3 py-2',
)

// Measured on the client: SSR renders the box without a tab stop, and a
// table that fits never gets one.
const box = ref<HTMLElement | null>(null)
const scrolls = ref(false)
let observer: ResizeObserver | undefined
onMounted(() => {
  const el = box.value
  if (!el) return
  const measure = () => {
    scrolls.value = el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1
  }
  observer = new ResizeObserver(measure)
  observer.observe(el)
  if (el.firstElementChild) observer.observe(el.firstElementChild)
  measure()
})
onBeforeUnmount(() => observer?.disconnect())

/** The row's header cell: the column named by `rowHeader`, else the first. */
const isHeader = (c: TableColumn) => c.key === (props.rowHeader ?? props.columns[0]?.key)

const cellClass = (c: TableColumn) => [
  pad.value,
  // A row header takes the highlight unless `rowClass` colors the whole row.
  isHeader(c)
    ? ['text-left font-normal', props.rowClass ? undefined : 'text-highlighted']
    : undefined,
  c.numeric ? 'whitespace-nowrap text-right font-mono' : undefined,
  c.class,
]

const value = (row: T, key: string) => {
  const v = (row as Record<string, unknown>)[key]
  return v === null || v === undefined || v === '' ? '—' : String(v)
}
</script>

<template>
  <div
    ref="box"
    class="max-h-[70dvh] overflow-auto rounded-sm focus-visible:outline-2 focus-visible:outline-primary"
    :tabindex="scrolls ? 0 : undefined"
    :role="scrolls ? 'region' : undefined"
    :aria-label="scrolls ? caption : undefined"
  >
    <table class="w-full" :class="nested ? 'text-xs' : 'text-sm'">
      <caption class="sr-only">
        {{
          caption
        }}
      </caption>
      <!-- The rule under the header is a shadow, not a border: a collapsed
           border stays behind when the header sticks. -->
      <thead class="sticky top-0 z-10 bg-default shadow-[inset_0_-1px_0_var(--ui-border)]">
        <tr class="text-left">
          <th
            v-for="c in columns"
            :key="c.key"
            scope="col"
            class="whitespace-nowrap text-xs font-medium text-muted"
            :class="[pad, c.numeric ? 'text-right' : undefined]"
          >
            {{ c.label }}
            <span v-if="c.hint" class="block max-w-48 whitespace-normal font-normal">{{
              c.hint
            }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(row, index) in rows"
          :id="rowId?.(row)"
          :key="rowKey(row)"
          class="border-b border-default last:border-0"
          :class="[align === 'top' ? 'align-top' : 'align-baseline', rowClass?.(row)]"
        >
          <template v-for="c in columns" :key="c.key">
            <td
              v-if="gap?.(row) && c.key === gapKeys[0]"
              :colspan="gapKeys.length"
              class="text-xs text-muted"
              :class="pad"
            >
              <slot name="gap" :row="row" />
            </td>
            <component
              :is="isHeader(c) ? 'th' : 'td'"
              v-else-if="!(gap?.(row) && gapKeys.includes(c.key))"
              :scope="isHeader(c) ? 'row' : undefined"
              :class="cellClass(c)"
            >
              <slot :name="`cell-${c.key}`" :row="row" :index="index">{{ value(row, c.key) }}</slot>
            </component>
          </template>
        </tr>
      </tbody>
    </table>
  </div>
</template>
