// A recipe: one public URL and a plain function that reads numbers out of
// what it returns. This is how a thesis gets data the lab pipeline does not
// carry — adding a company is a recipe file plus a thesis file, nothing
// else. The extractor is written (and repaired) with AI at dev time; on the
// schedule it is ordinary code, tested against a committed fixture.
//
// Rules for an extractor: deterministic, no clock, no network. Throw on a
// shape it does not recognize — a run that cannot read its source is
// flagged as failed, never stored as an empty result.

import type { CompanyId } from '#shared/utils/companies'

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
  extract(body: string): Observation[]
  /** The source's terms, where it states a license the data carries. */
  license?: string
}
