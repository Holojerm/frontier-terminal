// The weekly re-check of the power table's rows that cite a page off EDGAR: a
// utility's release, a regulator's bulletin, a company's own page. Those stay
// read by hand, since nothing finds the next such page for us, but a page can
// be edited or taken down, so once a week (tasks/power/verify.ts) each one is
// fetched again and each quote looked for on it:
//
//   - found: the row's fetched_at moves to now;
//   - the page answered and the quote is not on it, or the page is gone (404,
//     410): one ops event per row, and the row keeps its last stamp, so the
//     table still says when the quote was last seen. A person decides whether
//     the tie still holds;
//   - the page could not be read (a PDF, a host refusing a declared bot, a
//     timeout): the row keeps its last stamp and the run reports it.
//
// A row from an SEC filing is not re-read here: a filing never changes, and
// the filer's next filing is read by the filings lane (ingest.ts).

import { inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { recordOpsEvent } from '#server/utils/ops'
import { isSecHost, type SourceFetcher } from '../pipeline/fetch'
import { runStatements, type PipelineDb } from '../pipeline/store'
import { comparable, pageText } from '../utils/quote-match'
import { currentTies, seedHandTies } from './store'

export const KIND_QUOTE_GONE = 'power_quote_gone'

export interface PowerCheck {
  site: string
  what: string
  source_url: string
  status: 'found' | 'gone' | 'unread'
  /** Why the page could not be read, or why it counts as gone. */
  reason: string | null
}

export interface PowerVerifyReport {
  seeded: number
  checks: PowerCheck[]
}

type PageRead = { ok: true; text: string } | { ok: false; gone: boolean; reason: string }

const isPdf = (url: string, body: string) => /\.pdf($|\?)/i.test(url) || body.startsWith('%PDF')

async function readPage(fetcher: SourceFetcher, url: string): Promise<PageRead> {
  const res = await fetcher({ source_id: 'power-site-verify', url, ext: 'html' })
  if (!res.ok) {
    return { ok: false, gone: res.status === 404 || res.status === 410, reason: res.detail }
  }
  if (isPdf(url, res.text)) return { ok: false, gone: false, reason: 'PDF' }
  return { ok: true, text: comparable(pageText(res.text)) }
}

/** Re-read every page a current hand row off EDGAR cites, once each, and check its quotes. */
export async function verifyHandTies(
  db: PipelineDb,
  deps: { fetcher: SourceFetcher; now: Date },
): Promise<PowerVerifyReport> {
  const seeded = await seedHandTies(db)
  const now = deps.now.toISOString()
  const rows = (await currentTies(db)).filter((r) => r.basis === 'hand' && !isSecHost(r.source_url))
  const pages = new Map<string, Promise<PageRead>>()
  const read = (url: string) => {
    if (!pages.has(url)) pages.set(url, readPage(deps.fetcher, url))
    return pages.get(url)!
  }
  const checks: PowerCheck[] = []
  const found: string[] = []
  for (const r of rows) {
    const page = await read(r.source_url)
    const what = `${r.role} ${r.company_name}`
    let check: PowerCheck
    if (page.ok) {
      const there = page.text.includes(comparable(r.quote))
      if (there) found.push(r.id)
      check = {
        site: r.site,
        what,
        source_url: r.source_url,
        status: there ? 'found' : 'gone',
        reason: there ? null : 'quote not on the page',
      }
    } else {
      check = {
        site: r.site,
        what,
        source_url: r.source_url,
        status: page.gone ? 'gone' : 'unread',
        reason: page.reason,
      }
    }
    checks.push(check)
    if (check.status === 'gone') {
      await recordOpsEvent(db, {
        kind: KIND_QUOTE_GONE,
        detail: `${r.site}: ${what} — ${check.reason}; last found ${r.fetched_at} at ${r.source_url}`,
      })
    }
  }
  await runStatements(
    db,
    found.length
      ? [
          db
            .update(tables.powerSiteTies)
            .set({ fetched_at: now })
            .where(inArray(tables.powerSiteTies.id, found)),
        ]
      : [],
  )
  return { seeded, checks }
}
