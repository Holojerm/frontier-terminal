import type { FilingRow } from '../../contracts'
import { isPeriodicForm, isS1FloorForm } from './forms'

// The two deterministic significance rules (boundary table, judge row): an
// S-1/424B4 or a 10-Q/10-K on a whitelisted CIK always alerts, no model in
// the loop. Pure functions — the orchestrator wires them into the s1-floor
// and periodic-floor alert rules (server/pipeline/lanes.ts).

export { isPeriodicForm, isS1FloorForm }

/** Filings that trip the s1-floor rule: S-1/424B4 forms whose filer matched
 * the sources.yaml CIK whitelist. Non-whitelist S-1s (open-FTS noise) never
 * trip the floor. */
export function s1FloorFilings(rows: readonly FilingRow[]): FilingRow[] {
  return rows.filter((row) => row.whitelist_cik !== null && isS1FloorForm(row.form))
}

/** Filings that trip the periodic-floor rule: 10-Q/10-K on a whitelisted CIK. */
export function periodicFloorFilings(rows: readonly FilingRow[]): FilingRow[] {
  return rows.filter((row) => row.whitelist_cik !== null && isPeriodicForm(row.form))
}
