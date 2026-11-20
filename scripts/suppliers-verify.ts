// bun run suppliers:verify [--write]
//
// Re-reads every document the suppliers table cites and checks that each
// quote is still in it. The table is read by hand, so this is the only thing
// that keeps a row honest. --write stamps `fetched_at` on every row whose
// quote was found. Exits 1 when a document was read and a quote is not in it.
//
// A document that could not be read is listed and its rows keep their last
// stamp. sec.gov is sent the site's own User-Agent, with no contact address.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { curatedSuppliers, type CuratedSuppliers } from '../layers/terminal/shared/utils/suppliers'
import { comparable, pageText } from './lib/quote-match'

export const CURATED_PATH = join(
  import.meta.dirname,
  '../layers/terminal/server/curated/suppliers.json',
)

const TIMEOUT_MS = 60_000
/** sec.gov asks for no more than ten requests a second. */
const GAP_MS = 300
const USER_AGENT = 'Mozilla/5.0 (compatible; FrontierTerminal/1.0; +https://frontierterm.com)'

type PageRead = { ok: true; text: string; at: string } | { ok: false; reason: string; at: string }

async function readPage(url: string): Promise<PageRead> {
  const at = new Date().toISOString()
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, at }
    if (/pdf/i.test(res.headers.get('content-type') ?? '')) return { ok: false, reason: 'PDF', at }
    return { ok: true, text: comparable(pageText(await res.text())), at }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), at }
  }
}

export interface QuoteCheck {
  what: string
  source_url: string
  found: boolean
  /** Why the document could not be read, when it couldn't. */
  reason: string | null
}

/** Checks every quote, one fetch per document. Mutates `fetched_at` on the rows it finds. */
export async function verifyCurated(data: CuratedSuppliers): Promise<QuoteCheck[]> {
  const pages = new Map<string, PageRead>()
  const checks: QuoteCheck[] = []
  for (const row of data.rows) {
    if (!pages.has(row.source_url)) {
      if (pages.size) await new Promise((done) => setTimeout(done, GAP_MS))
      pages.set(row.source_url, await readPage(row.source_url))
    }
    const page = pages.get(row.source_url)!
    const found =
      page.ok &&
      page.text.includes(comparable(row.quote)) &&
      (!row.alias || page.text.includes(comparable(row.alias.quote)))
    if (found) row.fetched_at = page.at
    checks.push({
      what: `${row.ticker} ${row.relation} ${row.counterparty}`,
      source_url: row.source_url,
      found,
      reason: page.ok ? null : page.reason,
    })
  }
  return checks
}

if (import.meta.main) {
  const data = curatedSuppliers.parse(JSON.parse(readFileSync(CURATED_PATH, 'utf8')))
  const checks = await verifyCurated(data)
  const unread = checks.filter((c) => c.reason !== null)
  const gone = checks.filter((c) => !c.found && c.reason === null)
  for (const c of unread) console.warn(`unread (${c.reason}): ${c.what}\n  ${c.source_url}`)
  for (const c of gone) console.error(`quote gone: ${c.what}\n  ${c.source_url}`)
  console.warn(
    `${checks.filter((c) => c.found).length} of ${checks.length} quotes found, ${unread.length} in documents we could not read, ${gone.length} gone`,
  )
  if (process.argv.includes('--write')) {
    writeFileSync(CURATED_PATH, `${JSON.stringify(data, null, 2)}\n`)
  }
  process.exit(gone.length ? 1 : 0)
}
