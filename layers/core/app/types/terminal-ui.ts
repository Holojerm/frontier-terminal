// Prop shapes shared by the Terminal primitives and the pages that feed them
// (DESIGN.md › Terminal primitives).

/** A citation: the URL read and when, and optionally which feed it was. */
export interface Citation extends Prov {
  source_id?: string
  label?: string
}

export interface CaveatRef {
  text: string
  /** Visible trigger label; without one the trigger is the icon, named by `name`. */
  label?: string
  name?: string
}

/** A stated absence: what is missing, and why. */
export interface GapRef {
  title: string
  reason?: string
  name?: string
}

export interface TableColumn {
  key: string
  label: string
  /** Right-aligned mono figures. */
  numeric?: boolean
  /** Rendered beside the gap cell instead of under it — the source column. */
  keep?: boolean
  /** A second header line: what the column answers. */
  hint?: string
  class?: string
  /**
   * In a `stack` table below `sm`, where each cell is a label/value line:
   * `inline` drops the label and runs the value on one shared line with the
   * row's other inline cells (a time, a lab, a topic); `hide` drops a
   * secondary column on a phone.
   */
  stack?: 'inline' | 'hide'
}

/** A label spanning a run of columns in a header row above the column labels. */
export interface TableBand {
  label: string
  /** The column keys it spans, adjacent and in column order. */
  keys: readonly string[]
}

export interface Fact {
  key: string
  label: string
  value: string
  mono?: boolean
  /** Spans the full row of a grid — for a long value. */
  wide?: boolean
}
