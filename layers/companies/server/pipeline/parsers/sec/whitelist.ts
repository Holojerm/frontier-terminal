// CIK whitelist, read from the cik_whitelist block in sources.yaml. HONESTY
// RULE: a null entry can NEVER match, and this module never substitutes a
// number from memory — the gap stays visible until it is resolved from
// data.sec.gov. AMZN and NVDA were null through the audit and the first live
// runs; both were resolved from SEC on 2026-08-25 and verified against
// data.sec.gov (see sources.yaml). The rule stands for whatever is added next.
//
// The whitelist is an explicit input to the SEC parsers: there is no
// filesystem in a Worker, and a default baked into code would be exactly the
// from-memory number the rule forbids.

/** Ticker -> zero-padded 10-digit CIK, or null where the audit recorded no number. */
export type CikWhitelist = ReadonlyMap<string, string | null>

/** Narrow block reader (flat `KEY: "digits" | null` lines only, no YAML
 * dependency). The block ends at the first dedented line (next top-level
 * key) — a clean stop. An INDENTED line inside the block that does not match
 * the entry pattern throws instead of silently ending the block: a
 * formatting drift after e.g. SPCX must not silently drop GOOGL and suppress
 * an s1-floor alert. */
export function parseCikWhitelistBlock(yaml: string): Map<string, string | null> {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => /^cik_whitelist:\s*(#.*)?$/.test(l))
  if (start === -1) throw new Error('sources.yaml has no cik_whitelist block')

  const map = new Map<string, string | null>()
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*(#.*)?$/.test(line)) continue // blank or comment
    if (!/^\s/.test(line)) break // dedent = next top-level key, end of block
    const m = line.match(/^ {2}([A-Za-z0-9_]+):\s*(?:"(\d+)"|null)\s*(#.*)?$/)
    if (!m) {
      throw new Error(
        `cik_whitelist line ${i + 1} is not \`  TICKER: "digits" | null\`: ${JSON.stringify(line)}`,
      )
    }
    map.set(m[1]!, m[2] ?? null)
  }
  if (map.size === 0) throw new Error('cik_whitelist block is empty')
  return map
}

/** First CIK in the filing's own ciks array (source order) that matches a
 * non-null whitelist entry; null otherwise. Non-matches are NOT dropped by
 * callers — the open FTS query is known-noisy, and rows keep whitelist_cik
 * null instead of disappearing silently. */
export function whitelistCikFor(ciks: readonly string[], whitelist: CikWhitelist): string | null {
  const whitelisted = new Set<string>()
  for (const value of whitelist.values()) {
    if (value !== null) whitelisted.add(value)
  }
  for (const cik of ciks) {
    if (whitelisted.has(cik)) return cik
  }
  return null
}
