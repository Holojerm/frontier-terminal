// A recipe: one public URL and a plain function that reads numbers out of
// what it returns. This is how a thesis gets data the lab pipeline does not
// carry — adding a company is a recipe file plus a thesis file, nothing
// else. The extractor is written (and repaired) with AI at dev time; on the
// schedule it is ordinary code, tested against a committed fixture.
//
// Rules for an extractor: deterministic, no clock (the run's date is passed
// in), no network. Throw on a
// shape it does not recognize — a run that cannot read its source is
// flagged as failed, never stored as an empty result.

import type { CompanyId } from '../../../shared/utils/companies'

export interface Observation {
  /** What the number is of: a revenue tag, a department, a package, an entry. */
  key: string
  /** What it is for: YYYY-MM-DD (a quarter end, a day, an entry's date). */
  date: string
  value: number | null
  /** Everything else worth keeping — and all a judged rationale may cite. */
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
   * For a source found through another: `url` is fetched first and this
   * names the document to read from its body (an EDGAR submissions feed →
   * the newest filing). Everything else (hash, raw bytes, extract, the
   * stored source URL) is about the followed document.
   */
  follow?(body: string): string
}
