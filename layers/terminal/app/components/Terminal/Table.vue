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
// A secondary table scrolls in its own box: capped at 70% of the viewport,
// the header sticky to the top of the box, a wide table scrolling sideways
// inside it. The cap is svh, not dvh: dvh follows the mobile URL bar, which
// shows and hides as the page scrolls, so every capped box resized mid-swipe
// and everything below it jumped. The page's primary table (`flow`) runs as long as its rows
// instead, so the page never scrolls a box inside a scroll. A box that does
// scroll is a named, focusable region so a keyboard can scroll it (WCAG
// 2.1.1; axe scrollable-region-focusable).

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
    /**
     * The page's primary table: no scroll box, it runs as long as its rows and
     * its header sticks under the site header instead. Below `lg` it still
     * scrolls sideways in its own box, where the header does not stick.
     */
    flow?: boolean | 'top'
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

// Source cells inside a table render on one line (ProvenanceTag reads this).
provide(IN_TERMINAL_TABLE, true)

// Cell padding is set once on the <table> for every cell, not on each cell:
// repeated per cell it was about a quarter of /prices' markup. The selectors
// reach only this table's own rows (`>*>tr>*`), never a table nested in a cell.
// The reader's compact density halves the row padding. It is a `data-density`
// on <html>, set before first paint (plugins/reader-prefs.ts), so the class
// list is the same on the server and the client.
const pad = computed(() => [
  props.nested
    ? '[&>*>tr>*]:px-2 [&>*>tr>*]:py-1 in-data-[density=compact]:[&>*>tr>*]:py-0.5'
    : '[&>*>tr>*]:px-3 [&>*>tr>*]:py-2 in-data-[density=compact]:[&>*>tr>*]:py-1',
  props.nested || props.edge === false
    ? '[&>*>tr>:first-child]:pl-0 [&>*>tr>:last-child]:pr-0'
    : undefined,
])

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
  // A row header takes the highlight unless `rowClass` colors the whole row.
  isHeader(c)
    ? ['text-left font-normal', props.rowClass ? undefined : 'text-highlighted']
    : undefined,
  c.numeric ? 'whitespace-nowrap text-right font-mono' : undefined,
  c.class,
]

type Cell = { key: string; gap: boolean; span?: number; header: boolean }

/**
 * The cells a row renders: one per column, except that a gap row folds its
 * gap columns into one spanning cell. A flat list so the row renders with
 * one v-for, not a fragment (two comment nodes) around every cell.
 */
const cellsOf = (row: T): Cell[] => {
  const gapped = props.gap?.(row) ?? false
  const cells: Cell[] = []
  for (const c of props.columns) {
    if (gapped && c.key === gapKeys.value[0])
      cells.push({ key: c.key, gap: true, span: gapKeys.value.length, header: false })
    else if (!(gapped && gapKeys.value.includes(c.key)))
      cells.push({ key: c.key, gap: false, header: isHeader(c) })
  }
  return cells
}

const classes = computed(() => new Map(props.columns.map((c) => [c.key, cellClass(c)])))

const value = (row: T, key: string) => {
  const v = (row as Record<string, unknown>)[key]
  return v === null || v === undefined || v === '' ? '—' : String(v)
}
</script>

<template>
  <div
    ref="box"
    class="relative rounded-sm focus-visible:outline-2 focus-visible:outline-primary"
    :class="flow ? 'max-lg:overflow-x-auto' : 'max-h-[70svh] overflow-auto'"
    :tabindex="scrolls ? 0 : undefined"
    :role="scrolls ? 'region' : undefined"
    :aria-label="scrolls ? caption : undefined"
  >
    <!-- Inline links get a 24px-plus tap area from padding (the -mx-1 cancels the
           side padding's layout), which an inline box spends outside the line, so
           rows keep their density. Flex links carry
           their own min-h-6. -->
    <table
      class="w-full [&_:is(td,th)_a:not(.min-h-6)]:-mx-1 [&_:is(td,th)_a:not(.min-h-6)]:px-1 [&_:is(td,th)_a:not(.min-h-6)]:py-1.5"
      :class="[nested ? 'text-xs' : 'text-sm', pad]"
    >
      <caption class="sr-only">
        {{ caption }}
      </caption>
      <!-- The rule under the header is a shadow, not a border: a collapsed
           border stays behind when the header sticks. -->
      <thead
        class="z-10 bg-default shadow-[inset_0_-1px_0_var(--ui-border)]"
        :class="flow ? 'lg:sticky lg:top-(--header-offset)' : 'sticky top-0'"
      >
        <tr class="text-left">
          <th
            v-for="c in columns"
            :key="c.key"
            scope="col"
            class="whitespace-nowrap text-xs font-medium text-muted"
            :class="c.numeric ? 'text-right' : undefined"
          >
            {{ c.label }}
            <span v-if="c.hint" class="block max-w-48 whitespace-normal font-normal">{{
              c.hint
            }}</span>
          </th>
        </tr>
      </thead>
      <!-- Row rules and alignment, like the padding, are set once here. -->
      <tbody
        class="*:border-b *:border-default *:last:border-0"
        :class="align === 'top' ? '*:align-top' : '*:align-baseline'"
      >
        <tr
          v-for="(row, index) in rows"
          :id="rowId?.(row)"
          :key="rowKey(row)"
          :class="rowClass?.(row)"
        >
          <component
            :is="cell.header ? 'th' : 'td'"
            v-for="cell in cellsOf(row)"
            :key="cell.key"
            :colspan="cell.span"
            :scope="cell.header ? 'row' : undefined"
            :class="cell.gap ? 'text-xs text-muted' : classes.get(cell.key)"
          >
            <slot v-if="cell.gap" name="gap" :row="row" />
            <slot v-else :name="`cell-${cell.key}`" :row="row" :index="index">{{
              value(row, cell.key)
            }}</slot>
          </component>
        </tr>
      </tbody>
    </table>
  </div>
</template>
