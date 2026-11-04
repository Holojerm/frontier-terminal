import type { InjectionKey } from 'vue'

/**
 * Provided by TerminalTable to everything rendered in its cells. A citation in
 * a table cell sets on one line (TerminalProvenanceTag), because a cell that
 * wraps its source over three lines makes every row three lines tall.
 */
export const IN_TERMINAL_TABLE: InjectionKey<boolean> = Symbol('terminal-table')
