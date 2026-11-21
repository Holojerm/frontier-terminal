import type { ScopeEntry } from '#layers/core/server/pipeline/scopes'
import { freshRegistrationKey } from './prospectus-floor'

// The SEC feeds' share of the poll ticks (core's scopes.ts has the policy;
// server/registries/scopes.ts assembles the entries).

const EDGAR_SOURCES: readonly string[] = [
  'edgar-fts',
  'edgar-fts-openai',
  'edgar-submissions-spcx',
  'edgar-submissions-msft',
  'edgar-submissions-amzn',
  'edgar-submissions-nvda',
  'edgar-submissions-googl',
  'edgar-submissions-meta',
  'edgar-submissions-orcl',
  'edgar-submissions-baba',
  'edgar-companyfacts-spcx',
]

// A fresh registration filing's index and document ride the edgar tick until
// each has parsed once, so what an S-1 amendment says reaches an alert within
// an hour of the filing rather than at the next six-hourly tick. After that
// only the filings lane re-checks them: a filed document never changes, and a
// prospectus runs to 14 MB.
export const REGISTRATION_PREFIXES = ['filing-index-', 'prospectus-revenue-']

export function isRegistrationSource(id: string): boolean {
  return REGISTRATION_PREFIXES.some((p) => id.startsWith(p))
}

/**
 * The SEC feeds on the edgar tick: the static ones, then the derived EDGAR
 * feeds (a resolved lab's submissions and company facts,
 * layers/companies/server/pipeline/derived.ts), then fresh registrations.
 */
export const EDGAR_SCOPE: ScopeEntry = {
  sources: EDGAR_SOURCES,
  prefixes: ['edgar-'],
  untilParsed: { prefixes: REGISTRATION_PREFIXES, fresh: freshRegistrationKey },
}

/** The registration filings, alone in their own invocation. */
export const FILINGS_SCOPE: ScopeEntry = { prefixes: REGISTRATION_PREFIXES }
