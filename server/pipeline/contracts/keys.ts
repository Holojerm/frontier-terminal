import { createHash } from 'node:crypto'

// Stable keys per the boundary table's diff row: job ids, model slugs,
// accession numbers. A change event must be reproducible from two
// snapshots, so keys are pure functions of source-native identifiers.

export type Provider = 'openai' | 'anthropic' | 'google' | 'xai' | 'other'

export function jobKey(provider: Provider, jobId: string | number): string {
  return `job:${provider}:${jobId}`
}

// tier disambiguates multi-row SKUs (xAI long-context rows, Google
// standard/batch/flex/priority, promo windows).
export function modelKey(provider: Provider, slug: string, tier?: string | null): string {
  return tier ? `model:${provider}:${slug}:${tier}` : `model:${provider}:${slug}`
}

// One row per mapped matrix cell. The key is the cell, not the model: when
// a re-transcription moves a class to a new slug, the row diffs as 'modified'
// (old slug → new slug) rather than as a removal plus an addition.
export function recommendationKey(provider: Provider, klass: string): string {
  return `recommendation:${provider}:${klass}`
}

export function filingKey(accessionNo: string): string {
  return `filing:${accessionNo}`
}

// Status-page incident ids are page-scoped (Statuspage ULIDs/short ids,
// Google Cloud's own ids), so the provider is part of the key.
export function incidentKey(provider: Provider, incidentId: string): string {
  return `incident:${provider}:${incidentId}`
}

// One row per UTC day per model — the same (date, permaslug) fetched again
// diffs to nothing, so an overlapping window re-fetch is idempotent.
export function rankingKey(date: string, modelPermaslug: string): string {
  return `ranking:${date}:${modelPermaslug}`
}

// One resolved filer per lab: the row is rewritten if the resolution changes
// (it should not), never duplicated.
export function filerKey(provider: Provider): string {
  return `filer:${provider}`
}

// One XBRL fact: a filer's value for one tag over one period, as one filing
// reported it. The accession number is part of the key because a 10-K
// restates the prior year's quarters — the same period from two filings is
// two observations, and a value that differs between them is a restatement
// the reader should be able to see, not a silent overwrite.
export function revenueKey(
  cik: string,
  tag: string,
  accessionNo: string,
  start: string,
  end: string,
): string {
  return `revenue:${cik}:${tag}:${accessionNo}:${start}:${end}`
}

// Canonical serialization backing contentHash. Exported so consumers
// (normalize) share this exact algorithm instead of carrying a copy:
// contentHash(JSON.parse(payload)) === content_hash must hold.
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

// Content hash over a canonical serialization: key order never changes the
// hash, so diffs depend only on values.
export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

export function contentHashOfText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
