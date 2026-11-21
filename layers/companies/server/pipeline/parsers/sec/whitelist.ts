// CIK whitelist from sources.yaml's cik_whitelist block. HONESTY RULE: a null
// entry never matches and no number comes from memory; the gap stays visible
// until resolved from data.sec.gov. It is an explicit input because a Worker has
// no filesystem and a default in code would be a from-memory number.

/** Ticker -> zero-padded 10-digit CIK, or null where the audit recorded no number. */
export type CikWhitelist = ReadonlyMap<string, string | null>

/** Flat `KEY: "digits" | null` lines; the block ends at the first dedented line.
 * An indented line that doesn't match throws rather than ending the block, so a
 * drift after SPCX can't drop GOOGL and suppress an s1-floor alert. */
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

/** First CIK in the filing's ciks (source order) on a non-null whitelist entry, else
 * null. Callers keep non-matches with whitelist_cik null rather than drop them. */
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
