import type { FilingRow } from '#layers/core/server/utils/contracts'
import { isPeriodicForm, isS1FloorForm } from './forms'

// The deterministic floors: an S-1/424B4 or a 10-Q/10-K on a whitelisted CIK
// always alerts (wired in layers/companies/server/pipeline/filing-floors.ts).

export { isPeriodicForm, isS1FloorForm }

/** S-1/424B4 filings on a whitelisted CIK; other S-1s (open-FTS noise) never trip the floor. */
export function s1FloorFilings(rows: readonly FilingRow[]): FilingRow[] {
  return rows.filter((row) => row.whitelist_cik !== null && isS1FloorForm(row.form))
}
