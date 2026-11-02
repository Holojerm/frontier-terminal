// Prop shapes shared by the Terminal primitives and the pages that feed them
// (DESIGN.md › Terminal primitives).

import type { Prov } from '../../shared/utils/terminal-types'

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
}

export interface Fact {
  key: string
  label: string
  value: string
  mono?: boolean
  /** Spans the full row of a grid — for a long value. */
  wide?: boolean
}
