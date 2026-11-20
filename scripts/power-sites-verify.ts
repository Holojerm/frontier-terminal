// bun run power:verify [--write]
//
// Re-reads every page the power-sites table cites and checks that each quote
// is still on it. The table is read by hand, so this is the only thing that
// keeps a row honest after the page changes. --write stamps `fetched_at` on
// every row whose quote was found. Exits 1 when a page was read and the quote
// is no longer on it.
//
// A page that could not be read is listed and its rows keep their last stamp.
// That covers a PDF (nothing here can search one), a host that refuses a
// declared bot, and sec.gov unless NUXT_SEC_CONTACT_EMAIL is set (it asks for
// a contact address in the User-Agent).

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  curatedPowerSites,
  type CuratedPowerSites,
} from '../layers/terminal/shared/utils/power-sites'
import { comparable, pageText } from '../layers/terminal/server/utils/quote-match'

export const CURATED_PATH = join(
  import.meta.dirname,
  '../layers/terminal/server/curated/power-sites.json',
)

const TIMEOUT_MS = 30_000

// Re-exported for the tests that import them from here.
export { comparable, pageText }

export type PageRead =
  | { ok: true; text: string; at: string }
  | { ok: false; reason: string; at: string }

/** The User-Agent to send to a URL, or null when the host asks for one we cannot send. */
export type UserAgentFor = (url: string) => string | null

const isSec = (url: string) => /(^|\.)sec\.gov$/.test(new URL(url).hostname)

/** The pipeline's rule (layers/terminal/server/pipeline/fetch.ts › userAgentFor). */
export const siteUserAgent =
  (secContactEmail: string): UserAgentFor =>
  (url) =>
    isSec(url)
      ? secContactEmail
        ? `FrontierTerminal ${secContactEmail}`
        : null
      : 'Mozilla/5.0 (compatible; FrontierTerminal/1.0; +https://frontierterm.com)'

export async function readPage(url: string, userAgentFor: UserAgentFor): Promise<PageRead> {
  const at = new Date().toISOString()
  const userAgent = userAgentFor(url)
  if (!userAgent) return { ok: false, reason: 'no User-Agent we can send to this host', at }
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, at }
    const type = res.headers.get('content-type') ?? ''
    if (/pdf/i.test(type) || /\.pdf($|\?)/i.test(url)) return { ok: false, reason: 'PDF', at }
    return { ok: true, text: comparable(pageText(await res.text())), at }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), at }
  }
}

export interface QuoteCheck {
  site: string
  what: string
  source_url: string
  found: boolean
  /** Why the page could not be read, when it couldn't. */
  reason: string | null
  at: string
}

/** Checks every quote, one fetch per page. Mutates `fetched_at` on the rows it finds. */
export async function verifyCurated(
  data: CuratedPowerSites,
  userAgentFor: UserAgentFor,
): Promise<QuoteCheck[]> {
  const pages = new Map<string, Promise<PageRead>>()
  const read = (url: string) => {
    if (!pages.has(url)) pages.set(url, readPage(url, userAgentFor))
    return pages.get(url)!
  }
  const checks: QuoteCheck[] = []
  for (const site of data.sites) {
    const rows = [
      ...(site.grid ? [{ row: site.grid, what: `grid ${site.grid.name}` }] : []),
      ...site.links.map((l) => ({ row: l, what: `${l.role} ${l.company}` })),
    ]
    for (const { row, what } of rows) {
      const page = await read(row.source_url)
      const found = page.ok && page.text.includes(comparable(row.quote))
      if (found) row.fetched_at = page.at
      checks.push({
        site: site.site,
        what,
        source_url: row.source_url,
        found,
        reason: page.ok ? null : page.reason,
        at: page.at,
      })
    }
  }
  return checks
}

if (import.meta.main) {
  const data = curatedPowerSites.parse(JSON.parse(readFileSync(CURATED_PATH, 'utf8')))
  const checks = await verifyCurated(data, siteUserAgent(process.env.NUXT_SEC_CONTACT_EMAIL ?? ''))
  const unread = checks.filter((c) => c.reason !== null)
  const gone = checks.filter((c) => !c.found && c.reason === null)
  for (const c of unread)
    console.warn(`unread (${c.reason}): ${c.site}: ${c.what}\n  ${c.source_url}`)
  for (const c of gone) console.error(`quote gone: ${c.site}: ${c.what}\n  ${c.source_url}`)
  console.warn(
    `${checks.filter((c) => c.found).length} of ${checks.length} quotes found, ${unread.length} on pages we could not read, ${gone.length} gone`,
  )
  if (process.argv.includes('--write')) {
    writeFileSync(CURATED_PATH, `${JSON.stringify(data, null, 2)}\n`)
  }
  process.exit(gone.length ? 1 : 0)
}
