// A recipe: one public URL and a plain function that reads numbers out of what
// it returns, for data the lab pipeline does not carry. Extractors are written
// with AI at dev time and tested against a committed fixture. An extractor is
// deterministic (no clock, no network) and throws on a shape it does not know,
// so an unreadable source fails the run instead of storing an empty result.

import type { CompanyId } from '../../shared/utils/companies'

export interface Observation {
  /** What the number is of: a revenue tag, a department, a package, an entry. */
  key: string
  /** What it is for: YYYY-MM-DD (a quarter end, a day, an entry's date). */
  date: string
  value: number | null
  /** Everything else worth keeping, and all a judged rationale may cite. */
  payload: Record<string, unknown>
}

export interface Recipe {
  id: string
  company: CompanyId
  /** One line for the thesis page and the export. */
  description: string
  /** The URL for this run; `newest` is the newest stored date, null on the first run. */
  url(ctx: { now: Date; newest: string | null }): string
  /** Stored raw-payload extension: json, xml, md, html. */
  ext: string
  /** `date` is the run's UTC date (YYYY-MM-DD), for sources that report a current state, not a dated series. */
  extract(body: string, ctx: { date: string }): Observation[]
  /** The source's terms, where it states a license the data carries. */
  license?: string
  /**
   * What a change is judged on, for a body that differs on every fetch
   * (a per-request trace id). The raw bytes are still stored whole, but
   * only when this changes. Throws like `extract` on a shape it cannot read.
   */
  fingerprint?(body: string): string
  /**
   * Raise it when `extract` starts reading something new from the same
   * bytes. A run skips a body whose hash matches the last one stored, so
   * without this a new field would wait for the source to change before it
   * was first read. The revision is part of that hash.
   */
  revision?: number
  /**
   * For a source found through another: `url` is fetched first and this
   * names the document to read from its body (an EDGAR submissions feed →
   * the newest filing). Everything else (hash, raw bytes, extract, the
   * stored source URL) is about the followed document. `newest` is the
   * newest stored date, as `url` gets it, for a source that reads one
   * document per run and moves on from the last one stored.
   */
  follow?(body: string, ctx: { newest: string | null }): string
  /**
   * Earlier runs a source can still answer for (a search by date counts any
   * past day), fetched after this run's own URL, each with the run date
   * `extract` gets. `oldest` is the oldest stored date, null when none. Their
   * rows carry `retrospective: true`, being counted now from what still exists
   * upstream. The walk stops at the first failure, so it leaves no hole.
   */
  backfill?(ctx: { oldest: string | null }): { url: string; date: string }[]
}
