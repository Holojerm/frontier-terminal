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
// 2.1.1; axe scrollable-region-focusable). Its clipped edges fade, so a reader
// can see there is more to the side or below; the fade drops while the box
// has focus, since a mask would also hide the focus ring.
//
// `stack` is the phone form: below `sm` each row becomes a short block, the
// row header first and full width, then one label/value line per cell (or a
// shared line for the columns marked `stack: 'inline'`). The table keeps its
// markup and its header for a screen reader; only the layout changes.
//
// `foldGaps` puts every gap row after the figures and folds rows that state
// the same gap into one line naming them all, the way /revenue names its
// unreported labs once. `group` splits the rows into bodies headed by one
// spanning line, for a column that would otherwise repeat one reason down
// every row. `bands` adds a header row above the column labels, each band a
// `colgroup` heading over the columns it names.

import type { TableBand, TableColumn } from '#layers/core/app/types/terminal-ui'

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
    /** Below `sm`, each row stacks as label/value lines instead of scrolling sideways. */
    stack?: boolean
    /**
     * Fold gap rows that state the same gap into one line naming them all, after
     * the rows with figures. Returns the gap's identity: its text, usually.
     */
    foldGaps?: (row: T) => string
    /** A row's name in a folded gap line; the row header's value by default. */
    rowName?: (row: T) => string
    /**
     * Split the rows into groups, each headed by one spanning line: rows that
     * share a value run together under it, in the order the value first appears.
     */
    group?: (row: T) => string
    /** Headings over runs of adjacent columns, in a row above the column labels. */
    bands?: readonly TableBand[]
  }>(),
  // Vue casts an absent boolean prop to false; `edge` reads absent as true.
  { edge: true },
)

defineSlots<
  {
    [K in `cell-${string}`]?: (p: { row: T; index: number }) => unknown
  } & {
    /** `rows` is set on a folded line: every row it names, `row` the first. */
    gap?: (p: { row: T; rows?: T[] }) => unknown
    /** One name in a folded line, where each needs its own reason beside it. */
    'fold-name'?: (p: { row: T }) => unknown
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
  // A rule between row groups: each body's last row drops its own.
  '[&>tbody+tbody]:border-t [&>tbody+tbody]:border-default',
  // The band row sits on the column labels: its rule is the gap between them.
  props.bands?.length ? '[&>thead>tr:first-child>*]:pb-0' : undefined,
])

// The phone form, set once on the <table> like the padding. Its selectors
// name `tbody` and `td`/`th`, so they outrank the padding's `*`s. A cell's
// label is its column's, from `data-label`; `data-stack` marks the inline and
// hidden ones. Below `sm` the header row is only for a screen reader.
const stacked = computed(() =>
  props.stack
    ? [
        'max-sm:block max-sm:[&>thead]:sr-only max-sm:[&>tbody]:block',
        'max-sm:[&>tbody>tr]:flex max-sm:[&>tbody>tr]:flex-wrap max-sm:[&>tbody>tr]:gap-x-3 max-sm:[&>tbody>tr]:gap-y-1 max-sm:[&>tbody>tr]:py-2 in-data-[density=compact]:max-sm:[&>tbody>tr]:py-1',
        props.nested || props.edge === false ? undefined : 'max-sm:[&>tbody>tr]:px-3',
        'max-sm:[&>tbody>tr>*]:block max-sm:[&>tbody>tr>*]:basis-full max-sm:[&>tbody>tr>*]:p-0 max-sm:[&>tbody>tr>*]:text-left',
        'max-sm:[&>tbody>tr>th]:order-first',
        'max-sm:[&>tbody>tr>[data-stack=inline]]:basis-auto max-sm:[&>tbody>tr>[data-stack=hide]]:hidden',
        'max-sm:[&>tbody>tr>[data-label]]:relative max-sm:[&>tbody>tr>[data-label]]:pl-28',
        'max-sm:[&>tbody>tr>[data-label]]:before:absolute max-sm:[&>tbody>tr>[data-label]]:before:left-0 max-sm:[&>tbody>tr>[data-label]]:before:w-24 max-sm:[&>tbody>tr>[data-label]]:before:truncate max-sm:[&>tbody>tr>[data-label]]:before:font-sans max-sm:[&>tbody>tr>[data-label]]:before:text-xs max-sm:[&>tbody>tr>[data-label]]:before:leading-5 max-sm:[&>tbody>tr>[data-label]]:before:text-muted max-sm:[&>tbody>tr>[data-label]]:before:content-[attr(data-label)]',
      ]
    : undefined,
)

// Measured on the client: SSR renders the box without a tab stop or a fade,
// and a table that fits never gets either.
const box = ref<HTMLElement | null>(null)
const scrolls = ref(false)
const fade = reactive({ left: false, right: false, bottom: false })
let observer: ResizeObserver | undefined
let measure: (() => void) | undefined
onMounted(() => {
  const el = box.value
  if (!el) return
  measure = () => {
    const x = el.scrollWidth > el.clientWidth + 1
    const y = el.scrollHeight > el.clientHeight + 1
    scrolls.value = x || y
    fade.left = x && el.scrollLeft > 1
    fade.right = x && el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    fade.bottom = y && el.scrollTop + el.clientHeight < el.scrollHeight - 1
  }
  observer = new ResizeObserver(measure)
  observer.observe(el)
  if (el.firstElementChild) observer.observe(el.firstElementChild)
  el.addEventListener('scroll', measure, { passive: true })
  measure()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  if (measure) box.value?.removeEventListener('scroll', measure)
})

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

type Cell = {
  key: string
  gap: boolean
  span?: number
  header: boolean
  /** The column's label, for a stacked cell. */
  label?: string
  stack?: TableColumn['stack']
}

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
    else if (!(gapped && gapKeys.value.includes(c.key))) {
      const header = isHeader(c)
      cells.push({
        key: c.key,
        gap: false,
        header,
        label: props.stack && !header && !c.stack ? c.label : undefined,
        stack: props.stack && !header ? c.stack : undefined,
      })
    }
  }
  return cells
}

const classes = computed(() => new Map(props.columns.map((c) => [c.key, cellClass(c)])))

const value = (row: T, key: string) => {
  const v = (row as Record<string, unknown>)[key]
  return v === null || v === undefined || v === '' ? '—' : String(v)
}

const headerKey = computed(() => props.rowHeader ?? props.columns[0]?.key ?? '')
const nameOf = (row: T) => props.rowName?.(row) ?? value(row, headerKey.value)

/** Gap rows sharing one gap, folded into a line; each keeps its anchor. */
type Fold = { key: string; rows: T[] }

const folded = (row: T) => !!props.foldGaps && (props.gap?.(row) ?? false)

const folds = computed<Fold[]>(() => {
  if (!props.foldGaps) return []
  const byKey = new Map<string, T[]>()
  for (const row of props.rows) {
    if (!folded(row)) continue
    const key = props.foldGaps(row)
    byKey.set(key, [...(byKey.get(key) ?? []), row])
  }
  return [...byKey].map(([key, rows]) => ({ key, rows }))
})

/**
 * A folded line's cells: one row header spanning every column but the kept
 * ones (the gap, then the names), and the kept columns in place, each listing
 * every folded row's own (often none, so a stacked line gives them no label).
 * Assumes the kept columns sit at the end, as a source column does.
 */
const foldCells = computed(() => {
  const span = props.columns.filter((c) => !c.keep).length
  const cells: { key: string; line: boolean; span?: number }[] = []
  for (const c of props.columns) {
    if (c.keep) cells.push({ key: c.key, line: false })
    else if (!cells.some((x) => x.line)) cells.push({ key: c.key, line: true, span })
  }
  return cells
})

/** The bodies: one, or one per `group` value, each holding its rows in order. */
const bodies = computed(() => {
  const rows = props.foldGaps ? props.rows.filter((r) => !folded(r)) : props.rows
  if (!props.group) return [{ key: '', label: undefined, rows }]
  const byLabel = new Map<string, T[]>()
  for (const row of rows) {
    const label = props.group(row)
    byLabel.set(label, [...(byLabel.get(label) ?? []), row])
  }
  return [...byLabel].map(([label, rows]) => ({ key: label, label, rows }))
})

/**
 * The band row: one cell per run of adjacent columns that share a band, and
 * one empty cell per run outside any. Each run is also a `<colgroup>`, which
 * is what a `scope="colgroup"` heading applies to.
 */
const bandCells = computed(() => {
  if (!props.bands?.length) return []
  const bandOf = new Map(props.bands.flatMap((b) => b.keys.map((k) => [k, b.label] as const)))
  const cells: { key: string; label: string | undefined; span: number }[] = []
  for (const c of props.columns) {
    const label = bandOf.get(c.key)
    const last = cells.at(-1)
    if (last && last.label === label) last.span++
    else cells.push({ key: c.key, label, span: 1 })
  }
  return cells
})

/** Where each row sits in `rows`, for the cell slots' `index`. */
const indexOf = computed(() => new Map(props.rows.map((r, i) => [r, i])))
</script>

<template>
  <div
    ref="box"
    class="relative rounded-sm focus-visible:outline-2 focus-visible:outline-primary focus-visible:mask-none"
    :class="[
      flow ? 'max-lg:overflow-x-auto' : 'max-h-[70svh] overflow-auto',
      stack && !flow ? 'max-sm:max-h-none' : undefined,
      fade.left ? 'mask-l-from-[calc(100%-2rem)]' : undefined,
      fade.right ? 'mask-r-from-[calc(100%-2rem)]' : undefined,
      fade.bottom ? 'mask-b-from-[calc(100%-2rem)]' : undefined,
    ]"
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
      :class="[nested ? 'text-xs' : 'text-sm', pad, stacked]"
    >
      <caption class="sr-only">
        {{ caption }}
      </caption>
      <colgroup v-for="b in bandCells" :key="b.key" :span="b.span" />
      <!-- The rule under the header is a shadow, not a border: a collapsed
           border stays behind when the header sticks. -->
      <thead
        class="z-10 bg-default shadow-[inset_0_-1px_0_var(--ui-border)]"
        :class="flow ? 'lg:sticky lg:top-(--header-offset)' : 'sticky top-0'"
      >
        <!-- Each band's rule is drawn inside its cell's padding, so two
             adjacent bands read as two rules, not one. -->
        <tr v-if="bandCells.length">
          <template v-for="b in bandCells" :key="b.key">
            <th
              v-if="b.label"
              scope="colgroup"
              :colspan="b.span"
              class="text-left text-xs font-medium text-highlighted"
            >
              <span class="block border-b border-default pb-1">{{ b.label }}</span>
            </th>
            <td v-else :colspan="b.span" />
          </template>
        </tr>
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
        v-for="body in bodies"
        :key="body.key"
        class="*:border-b *:border-default *:last:border-0"
        :class="align === 'top' ? '*:align-top' : '*:align-baseline'"
      >
        <tr v-if="body.label !== undefined">
          <th
            scope="rowgroup"
            :colspan="columns.length"
            class="text-left text-xs font-normal text-muted"
          >
            {{ body.label }}
          </th>
        </tr>
        <tr v-for="row in body.rows" :id="rowId?.(row)" :key="rowKey(row)" :class="rowClass?.(row)">
          <component
            :is="cell.header ? 'th' : 'td'"
            v-for="cell in cellsOf(row)"
            :key="cell.key"
            :colspan="cell.span"
            :scope="cell.header ? 'row' : undefined"
            :data-label="cell.label"
            :data-stack="cell.stack"
            :class="cell.gap ? 'text-xs text-muted' : classes.get(cell.key)"
          >
            <slot v-if="cell.gap" name="gap" :row="row" />
            <slot v-else :name="`cell-${cell.key}`" :row="row" :index="indexOf.get(row) ?? 0">{{
              value(row, cell.key)
            }}</slot>
          </component>
        </tr>
      </tbody>
      <!-- The folded gaps: one line per gap, naming every row that states it.
           Each name keeps its row's anchor. -->
      <tbody
        v-if="folds.length"
        class="*:border-b *:border-default *:last:border-0"
        :class="align === 'top' ? '*:align-top' : '*:align-baseline'"
      >
        <tr v-for="f in folds" :key="f.key">
          <component
            :is="cell.line ? 'th' : 'td'"
            v-for="cell in foldCells"
            :key="cell.key"
            :colspan="cell.span"
            :scope="cell.line ? 'row' : undefined"
            :data-stack="stack && !cell.line ? 'inline' : undefined"
            :class="cell.line ? 'text-left text-xs font-normal text-muted' : classes.get(cell.key)"
          >
            <template v-if="cell.line">
              <slot name="gap" :row="f.rows[0]!" :rows="f.rows" />:
              <template v-for="(row, i) in f.rows" :key="rowKey(row)"
                ><template v-if="i > 0">, </template
                ><span :id="rowId?.(row)" class="whitespace-nowrap text-default"
                  ><slot name="fold-name" :row="row">{{ nameOf(row) }}</slot></span
                ></template
              >
            </template>
            <span v-else class="flex flex-wrap gap-x-3">
              <template v-for="row in f.rows" :key="rowKey(row)">
                <slot :name="`cell-${cell.key}`" :row="row" :index="indexOf.get(row) ?? 0" />
              </template>
            </span>
          </component>
        </tr>
      </tbody>
    </table>
  </div>
</template>
