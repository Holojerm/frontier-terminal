import {
  AlertRow,
  FilerRow,
  FilingRow,
  contentHash,
  type ChangeRow,
  type EntityRow,
} from './contracts'
import { isPeriodicForm, isS1FloorForm } from './parsers/sec/s1-floor'

// The synchronous SEC floors (boundary table, judge row): a NEW row of the
// right shape always alerts, no model in the loop. Only 'added' changes
// qualify — a baseline records no changes, so the historical filings in a
// filer's recent window never fire on first sight.
//
// Grounding: every value in the headline and explanation is read back out of
// the change row's after_json, re-validated against the row's own contract.

interface FloorSpec<R> {
  rule: Extract<AlertRow['rule'], 's1-floor' | 'periodic-floor' | 'cik-resolved'>
  entityType: EntityRow['entity_type']
  contract: { parse(value: unknown): R }
  applies: (row: R) => boolean
  severity: AlertRow['severity']
  /** Hashed with the rule into the alert id. Byte-for-byte stable: a change
   * here re-alerts every stored filing on the next poll. */
  idKey: (row: R, change: ChangeRow) => Record<string, string>
  headline: (row: R) => string
  explanation: (row: R) => string
}

function floor<R>(spec: FloorSpec<R>) {
  return (changes: readonly ChangeRow[]): AlertRow[] => {
    const alerts: AlertRow[] = []
    for (const change of changes) {
      if (
        change.change_type !== 'added' ||
        change.entity_type !== spec.entityType ||
        !change.after_json
      ) {
        continue
      }
      const row = spec.contract.parse({
        ...(JSON.parse(change.after_json) as Record<string, unknown>),
        source_url: change.source_url,
        fetched_at: change.fetched_at,
      })
      if (!spec.applies(row)) continue
      alerts.push(
        AlertRow.parse({
          id: contentHash({ rule: spec.rule, ...spec.idKey(row, change) }),
          severity: spec.severity,
          headline: spec.headline(row),
          explanation: spec.explanation(row),
          change_ids: JSON.stringify([change.id]),
          rule: spec.rule,
          created_at: change.detected_at,
          source_url: change.source_url,
          fetched_at: change.fetched_at,
        }),
      )
    }
    return alerts
  }
}

/** EDGAR full-text search suffixes each display name with "(CIK 0002130357)"; the submissions feed does not. */
const filerName = (name: string) => name.replace(/\s*\(CIK \d+\)\s*$/, '')

/** A NEW S-1/424B4 filing on a whitelisted CIK, `critical`. */
export const s1FloorAlerts = floor<FilingRow>({
  rule: 's1-floor',
  entityType: 'filing',
  contract: FilingRow,
  applies: (f) => f.whitelist_cik !== null && isS1FloorForm(f.form),
  severity: 'critical',
  // One alert per filing: the FTS tripwire and the filer's submissions feed
  // both list it, and whichever parses second finds this id stored.
  idKey: (f) => ({ accession_no: f.accession_no }),
  headline: (f) =>
    `${f.form} filed by ${f.display_names.map(filerName)[0] ?? `CIK ${f.whitelist_cik}`} (${f.file_date})`,
  explanation: (f) =>
    `Accession ${f.accession_no}: form ${f.form} filed ${f.file_date} by ` +
    `whitelisted CIK ${f.whitelist_cik} (${f.display_names.map(filerName).join(', ')}). ` +
    'An S-1/424B4 on a whitelisted filer always alerts — the s1-floor rule, no model in the loop. ' +
    'What the filing says follows in a prospectus-floor alert once its document is parsed.',
})

/** A NEW 10-Q/10-K/20-F on a whitelisted CIK, `notable`: a periodic report is
 * scheduled news, an S-1 is not. An 8-K is tracked but left to the judge
 * (parsers/sec/forms.ts). */
export const periodicFloorAlerts = floor<FilingRow>({
  rule: 'periodic-floor',
  entityType: 'filing',
  contract: FilingRow,
  applies: (f) => f.whitelist_cik !== null && isPeriodicForm(f.form),
  severity: 'notable',
  idKey: (_f, change) => ({ change_id: change.id }),
  headline: (f) =>
    `${f.form} filed by ${f.display_names[0] ?? `CIK ${f.whitelist_cik}`} (${f.file_date})`,
  explanation: (f) =>
    `Accession ${f.accession_no}: form ${f.form} filed ${f.file_date} by ` +
    `whitelisted CIK ${f.whitelist_cik} (${f.display_names.join(', ')}). ` +
    'A 10-Q, 10-K or 20-F on a whitelisted filer always alerts — the periodic-floor rule, no model in the loop. ' +
    'Where the filer is a tagged revenue filer, its XBRL revenue facts refresh on the /revenue panel at the next company-facts poll.',
})

/** A lab's CIK resolved from its own S-1 hit (a NEW `filer` row), `critical`:
 * the public-flip moment the whole SEC axis waits for. */
export const cikResolvedAlerts = floor<FilerRow>({
  rule: 'cik-resolved',
  entityType: 'filer',
  contract: FilerRow,
  applies: () => true,
  severity: 'critical',
  idKey: (_f, change) => ({ change_id: change.id }),
  headline: (f) =>
    `${f.name} filed ${f.resolved_form} (${f.resolved_file_date}) — CIK ${f.cik} resolved for ${f.provider}`,
  explanation: (f) =>
    `Accession ${f.resolved_accession}: form ${f.resolved_form} filed ${f.resolved_file_date} by ` +
    `${f.name} (CIK ${f.cik}), whose name matches the ${f.provider} pattern in sources.yaml pending_filers. ` +
    'A registration filing by a pending lab always alerts — the cik-resolved rule, no model in the loop. ' +
    'From the next poll the CIK is whitelisted and the filer’s submissions and XBRL company-facts feeds are derived and polled; ' +
    'its reported revenue lands on /revenue as an issuer filing.',
})
