import type { FilingRow } from '../../contracts'

// The one deterministic significance rule (boundary table, judge row): an
// S-1/424B4 hit on a whitelisted CIK always alerts, no model in the loop.
// Pure functions — the orchestrator wires them into the s1-floor alert rule.

/** True for the S-1 registration family (S-1 and its /A amendments) and the
 * 424B4 final prospectus. Deliberately NOT matched: DRS (confidential
 * drafts are structurally invisible until flipped public — non-goals), S-8,
 * and every periodic form. */
export function isS1FloorForm(form: string): boolean {
  const root = form.replace(/\/A$/, '')
  return root === 'S-1' || root === '424B4'
}

/** Filings that trip the s1-floor rule: S-1/424B4 forms whose filer matched
 * the sources.yaml CIK whitelist. Non-whitelist S-1s (open-FTS noise) never
 * trip the floor. */
export function s1FloorFilings(rows: readonly FilingRow[]): FilingRow[] {
  return rows.filter((row) => row.whitelist_cik !== null && isS1FloorForm(row.form))
}
