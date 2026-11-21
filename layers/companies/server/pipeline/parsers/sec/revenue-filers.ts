import type { Provider } from '#layers/core/server/utils/contracts'
import type { CikWhitelist } from './whitelist'

// Which lab a revenue filer's facts belong to, from sources.yaml's revenue_filers
// block. HONESTY RULE (as for the CIK whitelist): a null entry never matches and
// no filer is substituted from memory; the /revenue panel shows the gap instead.
// `relation` is `issuer` (the lab files) or `parent` (a public parent consolidates
// it; the series is the parent's). `segment` narrows a parent to one
// StatementBusinessSegmentsAxis member (parsers/sec/xbrl-segment.ts). `effective`
// is the UTC day an entry took effect; an as_of read before it sees the lab untagged.

type FilerRelation = 'issuer' | 'parent'

export interface RevenueFiler {
  ticker: string
  relation: FilerRelation
  /** The segment member the series is read on (goog:GoogleCloudMember); absent for a consolidated series. */
  segment?: string
  /** YYYY-MM-DD the entry took effect; absent when it has held since the block began. */
  effective?: string
}

/** Provider -> filer, or null where the block says the lab has no disclosure. */
export type RevenueFilers = ReadonlyMap<Provider, RevenueFiler | null>

const LAB_PROVIDERS: readonly Provider[] = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'meta',
  'mistral',
  'deepseek',
  'alibaba',
  'moonshot',
]

/** Narrow block reader for `  provider: null` or `  provider:` plus indented
 * ticker/relation/segment/effective lines. Any other indented line throws, so a
 * drift can't silently untag a filer. */
export function parseRevenueFilersBlock(yaml: string): Map<Provider, RevenueFiler | null> {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => /^revenue_filers:\s*(#.*)?$/.test(l))
  if (start === -1) throw new Error('sources.yaml has no revenue_filers block')

  const map = new Map<Provider, RevenueFiler | null>()
  let current: {
    provider: Provider
    ticker?: string
    relation?: string
    segment?: string
    effective?: string
  } | null = null
  const flush = () => {
    if (!current) return
    if (current.ticker === undefined || current.relation === undefined) {
      throw new Error(`revenue_filers ${current.provider}: needs both ticker and relation`)
    }
    if (current.relation !== 'issuer' && current.relation !== 'parent') {
      throw new Error(`revenue_filers ${current.provider}: relation must be issuer or parent`)
    }
    if (current.segment !== undefined && current.relation !== 'parent') {
      throw new Error(`revenue_filers ${current.provider}: a segment is only read off a parent`)
    }
    map.set(current.provider, {
      ticker: current.ticker,
      relation: current.relation,
      ...(current.segment !== undefined && { segment: current.segment }),
      ...(current.effective !== undefined && { effective: current.effective }),
    })
    current = null
  }
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*(#.*)?$/.test(line)) continue
    if (!/^\s/.test(line)) break
    const head = line.match(/^ {2}([a-z]+):\s*(null)?\s*(#.*)?$/)
    if (head) {
      flush()
      const provider = head[1] as Provider
      if (!LAB_PROVIDERS.includes(provider)) {
        throw new Error(`revenue_filers line ${i + 1}: unknown provider ${provider}`)
      }
      if (head[2] === 'null') map.set(provider, null)
      else current = { provider }
      continue
    }
    const field = line.match(/^ {4}(ticker|relation):\s*([A-Za-z0-9_]+)\s*(#.*)?$/)
    if (field && current) {
      if (field[1] === 'ticker') current.ticker = field[2]!
      else current.relation = field[2]!
      continue
    }
    const segment = line.match(/^ {4}segment:\s*([a-z][a-z0-9-]*:[A-Za-z0-9]+Member)\s*(#.*)?$/)
    if (segment && current) {
      current.segment = segment[1]!
      continue
    }
    const effective = line.match(/^ {4}effective:\s*(\d{4}-\d{2}-\d{2})\s*(#.*)?$/)
    if (effective && current) {
      current.effective = effective[1]!
      continue
    }
    throw new Error(
      `revenue_filers line ${i + 1} is not \`  provider: null\` or \`    ticker|relation|segment|effective: value\`: ${JSON.stringify(line)}`,
    )
  }
  flush()
  for (const provider of LAB_PROVIDERS) {
    if (!map.has(provider)) throw new Error(`revenue_filers has no entry for ${provider}`)
  }
  return map
}

/** The lab whose filer carries this CIK, resolved ticker -> CIK through the
 * whitelist; 'other' when no tagged filer matches. */
export function revenueProviderFor(
  cik: string,
  filers: RevenueFilers,
  whitelist: CikWhitelist,
): Provider {
  for (const [provider, filer] of filers) {
    if (filer && whitelist.get(filer.ticker) === cik) return provider
  }
  return 'other'
}

/**
 * The lab whose own filer (relation `issuer`) carries this CIK, else 'other'. A
 * parent's filing (SpaceX for xAI) stays 'other'; a lab resolved from its S-1
 * joins as an issuer (refresh.ts), so its 424B4 reads as the lab's.
 */
export function issuerProviderFor(
  cik: string | null,
  filers: RevenueFilers,
  whitelist: CikWhitelist,
): Provider {
  if (cik === null) return 'other'
  for (const [provider, filer] of filers) {
    if (filer?.relation === 'issuer' && whitelist.get(filer.ticker) === cik) return provider
  }
  return 'other'
}

/** The entry in force on `at`'s UTC day: one not yet effective reads as untagged (null). */
export function filerAt(filer: RevenueFiler | null, at: string | null): RevenueFiler | null {
  if (!filer || at === null || filer.effective === undefined) return filer
  return at.slice(0, 10) < filer.effective ? null : filer
}
