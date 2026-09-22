import { FilerRow, type FilingRow, type Provider } from '../../contracts'

// The CIK resolver: which lab a registration filing belongs to, decided by
// the pending_filers block in sources.yaml and nothing else. HONESTY RULE,
// as for the whitelist: a CIK is read off an EDGAR hit's own display name,
// never typed from memory, and the resolving filing travels on the row.
//
// Pure functions. The lane runs resolveFilers over the FTS rows it just
// parsed; the refresh unions the result into the whitelist for every later
// tick and derives the lab's feeds from it (server/pipeline/derived.ts).

export interface PendingFiler {
  provider: Provider
  /** Case-insensitive regex source, tested against the filer name. */
  name_pattern: string
}

export interface PendingFilers {
  filers: PendingFiler[]
  /** Whole-word, case-insensitive: a filer name carrying any of these never resolves. */
  exclude: string[]
}

const LAB_PROVIDERS: readonly Provider[] = ['openai', 'anthropic', 'google', 'xai']

/** Narrow block reader: `  exclude: a, b` and `  provider:` / `    name_pattern: …`. */
export function parsePendingFilersBlock(yaml: string): PendingFilers {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => /^pending_filers:\s*(#.*)?$/.test(l))
  if (start === -1) throw new Error('sources.yaml has no pending_filers block')

  const out: PendingFilers = { filers: [], exclude: [] }
  let current: Provider | null = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*(#.*)?$/.test(line)) continue
    if (!/^\s/.test(line)) break
    const exclude = line.match(/^ {2}exclude:\s*(.+?)\s*$/)
    if (exclude) {
      out.exclude = exclude[1]!
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      current = null
      continue
    }
    const head = line.match(/^ {2}([a-z]+):\s*(#.*)?$/)
    if (head) {
      current = head[1] as Provider
      if (!LAB_PROVIDERS.includes(current)) {
        throw new Error(`pending_filers line ${i + 1}: unknown provider ${current}`)
      }
      continue
    }
    const pattern = line.match(/^ {4}name_pattern:\s*(.+?)\s*$/)
    if (pattern && current) {
      new RegExp(pattern[1]!, 'i') // throws on a bad pattern, at read time
      out.filers.push({ provider: current, name_pattern: pattern[1]! })
      current = null
      continue
    }
    throw new Error(`pending_filers line ${i + 1} is not a filer field: ${JSON.stringify(line)}`)
  }
  return out
}

/** EDGAR's display name is "NAME  (TICKER)  (CIK 0001234567)"; the filer name is the part before the first parenthesis. */
export function filerNameOf(displayName: string): string {
  return displayName.split(/\s+\(/)[0]!.trim()
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function excluded(name: string, exclude: readonly string[]): boolean {
  return exclude.some((term) =>
    new RegExp(`(^|[^a-z0-9])${escape(term)}($|[^a-z0-9])`, 'i').test(name),
  )
}

const S1_FAMILY = /^(S-1|424B4)(\/A)?$/

/**
 * Pure: the filer rows the parsed hits resolve. Only S-1-family forms are
 * considered (the funds and SPVs that carry a lab's name file Form D); a
 * lab resolves from the EARLIEST matching filing (file_date, then
 * accession), so amendments never move the row. A lab already resolved by
 * `already` (the whitelist, in effect) is skipped: the audited file wins.
 */
export function resolveFilers(
  rows: readonly FilingRow[],
  pending: PendingFilers,
  already: ReadonlySet<Provider>,
): FilerRow[] {
  const out: FilerRow[] = []
  for (const { provider, name_pattern } of pending.filers) {
    if (already.has(provider)) continue
    const pattern = new RegExp(name_pattern, 'i')
    let best: { row: FilingRow; cik: string; name: string } | null = null
    for (const row of rows) {
      if (!S1_FAMILY.test(row.form)) continue
      for (let i = 0; i < row.ciks.length; i++) {
        const display = row.display_names[i] ?? ''
        const name = filerNameOf(display)
        const cikMatch = display.match(/\(CIK (\d{10})\)/)
        const cik = cikMatch?.[1] ?? row.ciks[i]!
        if (!pattern.test(name) || excluded(name, pending.exclude)) continue
        const better =
          best === null ||
          row.file_date < best.row.file_date ||
          (row.file_date === best.row.file_date && row.accession_no < best.row.accession_no)
        if (better) best = { row, cik, name }
      }
    }
    if (!best) continue
    out.push(
      FilerRow.parse({
        provider,
        cik: best.cik,
        name: best.name,
        resolved_form: best.row.form,
        resolved_accession: best.row.accession_no,
        resolved_file_date: best.row.file_date,
        source_url: best.row.source_url,
        fetched_at: best.row.fetched_at,
      }),
    )
  }
  return out
}
