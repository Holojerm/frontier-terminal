import {
  documentKey,
  filerKey,
  filingKey,
  offeringKey,
  commitmentKey,
  concentrationKey,
  riskFactorsKey,
  sharesKey,
  statementKey,
  stableStringify,
  revenueKey,
  type EntityRow,
  type FilerRow,
  type FilingRow,
  type OfferingRow,
  type ProspectusOutput,
  type Provider,
  type RegistrationDocumentRow,
  type RevenueRow,
} from '../../../core/server/utils/contracts'
import { collapse, toEntity } from '../../../core/server/pipeline/normalize'

// Normalize: validated parser-output rows -> EntityRow (boundary table,
// "normalize" = DETERMINISTIC). Pure functions of their inputs: no clock,
// no randomness, no iteration-order dependence.

// Canonical serialization: the same stableStringify that backs contentHash
// (one algorithm), so contentHash(JSON.parse(payload)) === content_hash and
// a change event is reproducible from the stored payloads alone.
export { stableStringify }

// FilingRow carries no provider field: EDGAR filers (SPCX, MSFT, ...) are
// whitelisted public companies, not the private big-4 labs, so the default
// is "other". The SEC lanes override it only when a filing is a lab's own
// (the S-1 public-flip moment): revenue-filers.ts › issuerProviderFor.
export function normalizeFiling(
  row: FilingRow,
  snapshotId: string,
  provider: Provider = 'other',
): EntityRow {
  return toEntity(filingKey(row.accession_no), 'filing', provider, snapshotId, row)
}

// One row per resolved lab, keyed by provider: a second resolving hit for
// the same lab rewrites the row (a 'modified' change) rather than adding one.
export function normalizeFilers(rows: readonly FilerRow[], snapshotId: string): EntityRow[] {
  return collapse(
    rows.map((row) => toEntity(filerKey(row.provider), 'filer', row.provider, snapshotId, row)),
  )
}

// One row per registration filing; a filing index never changes once accepted.
export function normalizeDocuments(
  rows: readonly RegistrationDocumentRow[],
  snapshotId: string,
): EntityRow[] {
  return collapse(
    rows.map((row) =>
      toEntity(documentKey(row.accession_no), 'document', row.provider, snapshotId, row),
    ),
  )
}

export function normalizeOfferings(rows: readonly OfferingRow[], snapshotId: string): EntityRow[] {
  return collapse(
    rows.map((row) =>
      toEntity(offeringKey(row.accession_no), 'offering', row.provider, snapshotId, row),
    ),
  )
}

// What else one registration document prints (parsers/sec/prospectus.ts),
// keyed per filing — and per period for the statement — so an amendment's
// rows sit beside the original's rather than replacing them.
export function normalizeProspectusDetails(
  out: Pick<
    ProspectusOutput,
    'statements' | 'commitments' | 'concentration' | 'shares' | 'risk_factors'
  >,
  snapshotId: string,
): EntityRow[] {
  const rf = out.risk_factors
  return collapse([
    ...out.statements.map((r) =>
      toEntity(
        statementKey(r.cik, r.accession_no, r.start, r.end),
        'statement',
        r.provider,
        snapshotId,
        r,
      ),
    ),
    ...out.commitments.map((r) =>
      toEntity(
        commitmentKey(r.accession_no, r.schedule, r.as_of),
        'commitment',
        r.provider,
        snapshotId,
        r,
      ),
    ),
    ...out.concentration.map((r) =>
      toEntity(
        concentrationKey(r.accession_no, r.basis),
        'concentration',
        r.provider,
        snapshotId,
        r,
      ),
    ),
    ...(out.shares
      ? [
          toEntity(
            sharesKey(out.shares.accession_no),
            'shares',
            out.shares.provider,
            snapshotId,
            out.shares,
          ),
        ]
      : []),
    ...(rf
      ? [toEntity(riskFactorsKey(rf.accession_no), 'risk_factors', rf.provider, snapshotId, rf)]
      : []),
  ])
}

// A revenue fact's provider is the lab whose filer reported it, resolved by
// the lane from sources.yaml (revenue_filers + cik_whitelist); the row
// itself carries only the filer. `val` is the whole content, so a restated
// figure in a later filing is a new key (the accession differs), and a
// corrected value under the SAME accession diffs as 'modified'.
export function normalizeRevenue(
  row: RevenueRow,
  snapshotId: string,
  provider: Provider,
): EntityRow {
  return toEntity(
    revenueKey(row.cik, row.tag, row.accession_no, row.start, row.end, row.segment),
    'revenue',
    provider,
    snapshotId,
    row,
  )
}

export function normalizeRevenues(
  rows: readonly RevenueRow[],
  snapshotId: string,
  provider: Provider,
): EntityRow[] {
  return collapse(rows.map((row) => normalizeRevenue(row, snapshotId, provider)))
}

/** `provider` is one lab for every row, or the lab of each row (lanes.ts reads it off the filer's CIK). */
export function normalizeFilings(
  rows: readonly FilingRow[],
  snapshotId: string,
  provider: Provider | ((row: FilingRow) => Provider) = 'other',
): EntityRow[] {
  const of = typeof provider === 'function' ? provider : () => provider
  return collapse(rows.map((row) => normalizeFiling(row, snapshotId, of(row))))
}
