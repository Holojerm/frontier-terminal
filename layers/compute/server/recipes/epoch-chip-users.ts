// Epoch AI's "AI chip users" dataset (CC BY 4.0): each lab's compute in
// H100-equivalents, median with 5th and 95th percentiles, plus a file rating each
// chip type in H100-equivalents. Year-end estimates Epoch calls "substantially
// uncertain, especially for Meta Superintelligence Labs and Google DeepMind", so
// the percentiles always travel with the median.

import type { Observation, Recipe } from '#layers/core/server/recipes/contract'
import { parseCsv } from '#layers/core/server/recipes/csv'

function column(row: Record<string, string>, field: string): string {
  const v = row[field]
  if (v === undefined) throw new Error(`no ${field} column`)
  return v
}

function num(row: Record<string, string>, field: string): number {
  const n = Number(column(row, field))
  if (column(row, field).trim() === '' || !Number.isFinite(n)) {
    throw new Error(`${field} is not a number: ${row[field]}`)
  }
  return n
}

/** One observation per lab, year and model step, dated the year's end. */
export function extractChipUsers(body: string): Observation[] {
  const rows = parseCsv(body)
  if (rows.length === 0) throw new Error('no rows')
  return rows.map((r) => {
    const year = column(r, 'Year')
    if (!/^\d{4}$/.test(year)) throw new Error(`year is not a year: ${year}`)
    return {
      key: `${column(r, 'Lab')}|${column(r, 'Variable')}`,
      date: `${year}-12-31`,
      value: num(r, 'value_med'),
      payload: {
        lab: column(r, 'Lab'),
        variable: column(r, 'Variable'),
        label: column(r, 'Label'),
        kind: column(r, 'Kind'),
        units: column(r, 'Units'),
        p5: num(r, 'value_p5'),
        p95: num(r, 'value_p95'),
      },
    }
  })
}

/** One observation per chip type: its H100-equivalents, dated the run. A type Epoch leaves blank is kept as null. */
export function extractChipTypes(body: string, ctx: { date: string }): Observation[] {
  const rows = parseCsv(body)
  if (rows.length === 0) throw new Error('no rows')
  return rows.map((r) => {
    const raw = column(r, 'H100e').trim()
    return {
      key: column(r, 'Name').trim(),
      date: ctx.date,
      value: raw === '' ? null : num(r, 'H100e'),
      payload: { designer: column(r, 'Designer').trim() },
    }
  })
}

export const EPOCH_CHIP_USERS: Recipe = {
  id: 'epoch-chip-users',
  company: 'frontier-labs',
  description:
    'Epoch AI chip users: year-end compute per developer in H100e, median with 5th and 95th percentiles, and the model steps behind it',
  url: () => 'https://epoch.ai/data/ai_chip_users_intermediates_by_lab.csv',
  ext: 'csv',
  extract: extractChipUsers,
  license:
    "CC BY 4.0. Epoch AI, 'Data on AI chip users'. Published online at epoch.ai. Retrieved from 'https://epoch.ai/data/ai-chip-users'",
}

export const EPOCH_CHIP_TYPES: Recipe = {
  id: 'epoch-chip-types',
  company: 'frontier-labs',
  description: 'Epoch AI chip types: each AI chip rated in H100-equivalents',
  url: () => 'https://epoch.ai/data/ai_chip_sales_chip_types.csv',
  ext: 'csv',
  extract: extractChipTypes,
  license:
    "CC BY 4.0. Epoch AI, 'Data on AI chip sales'. Published online at epoch.ai. Retrieved from 'https://epoch.ai/data/ai-chip-sales'",
}
