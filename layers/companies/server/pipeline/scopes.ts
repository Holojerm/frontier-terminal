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

// A fresh registration's index and document ride the edgar tick until each has
// parsed once, so an amendment alerts within the hour. After that only the
// filings lane re-checks them: a filed document never changes, and runs to 14 MB.
export const REGISTRATION_PREFIXES = ['filing-index-', 'prospectus-revenue-']

export function isRegistrationSource(id: string): boolean {
  return REGISTRATION_PREFIXES.some((p) => id.startsWith(p))
}

/** The edgar tick's SEC feeds: static, derived (layers/companies/server/pipeline/derived.ts), then fresh registrations. */
export const EDGAR_SCOPE: ScopeEntry = {
  sources: EDGAR_SOURCES,
  prefixes: ['edgar-'],
  untilParsed: { prefixes: REGISTRATION_PREFIXES, fresh: freshRegistrationKey },
}

/** The registration filings, alone in their own invocation. */
export const FILINGS_SCOPE: ScopeEntry = { prefixes: REGISTRATION_PREFIXES }
