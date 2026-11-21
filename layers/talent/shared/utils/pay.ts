// The payload behind the posted-pay panels (layers/talent/server/utils/terminal-pay.ts):
// the median midpoint of each lab's posted US salary bands per department
// cell, against the reading before. Every figure carries the URL it was read
// from and when.

export interface PayCell {
  key: string
  label: string
  median: number
  p25: number
  p75: number
  n: number
  departments: readonly string[] | null
  /** The cell's median at the previous stored reading, when there is one. */
  previous: { date: string; median: number } | null
}

export interface PayData {
  as_of: string | null
  boards: {
    recipe_id: string
    lab: LabId
    date: string
    roles_on_board: number
    cells: PayCell[]
    source: RecipeCitation
  }[]
  caveat: string
}
