import type { Provider } from '../../contracts'
import type { CikWhitelist } from './whitelist'

// Which lab a revenue filer's facts belong to, read from the revenue_filers
// block in sources.yaml. HONESTY RULE, as for the CIK whitelist: a null
// entry can never match, nothing here substitutes a filer from memory, and
// the /revenue panel shows the gap instead of a press run-rate.
//
// `relation` is the one judgment the block records: `issuer` when the lab
// files for itself, `parent` when a public parent consolidates it — and a
// parent's series is the parent's, labelled so wherever it is shown.

export type FilerRelation = 'issuer' | 'parent'

export interface RevenueFiler {
  ticker: string
  relation: FilerRelation
}

/** Provider -> filer, or null where the block says the lab has no disclosure. */
export type RevenueFilers = ReadonlyMap<Provider, RevenueFiler | null>

const LAB_PROVIDERS: readonly Provider[] = ['openai', 'anthropic', 'google', 'xai']

/** Narrow block reader: `  provider: null` or `  provider:` followed by
 * `    ticker:` and `    relation:` lines. Any indented line that fits
 * neither shape throws — a drift here must not silently untag a filer. */
export function parseRevenueFilersBlock(yaml: string): Map<Provider, RevenueFiler | null> {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => /^revenue_filers:\s*(#.*)?$/.test(l))
  if (start === -1) throw new Error('sources.yaml has no revenue_filers block')

  const map = new Map<Provider, RevenueFiler | null>()
  let current: { provider: Provider; ticker?: string; relation?: string } | null = null
  const flush = () => {
    if (!current) return
    if (current.ticker === undefined || current.relation === undefined) {
      throw new Error(`revenue_filers ${current.provider}: needs both ticker and relation`)
    }
    if (current.relation !== 'issuer' && current.relation !== 'parent') {
      throw new Error(`revenue_filers ${current.provider}: relation must be issuer or parent`)
    }
    map.set(current.provider, { ticker: current.ticker, relation: current.relation })
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
    throw new Error(
      `revenue_filers line ${i + 1} is not \`  provider: null\` or \`    ticker|relation: value\`: ${JSON.stringify(line)}`,
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
