// Which EDGAR forms the submissions parsers keep, and which of those the
// two deterministic floor rules fire on. One list, so a form added here
// reaches the store, the floors and the judge together.
//
// A filer's submissions feed is mostly Form 4 (insider trades), 144 and
// SC 13G notices — Microsoft's newest 150 filings hold nine tracked forms
// among 141 of those. Keeping every row would hand the judge "an SEC
// change" several times a day per filer, none of them about the business.
// The FTS feed is not filtered: its query already names the form.

/** Root form (amendment suffix stripped): "S-1/A" -> "S-1". */
export function rootForm(form: string): string {
  return form.replace(/\/A$/, '')
}

/** The S-1 registration family, the final prospectus, and the periodic
 * reports that carry XBRL financials or a material event. 20-F is a foreign
 * private issuer's annual report (Alibaba's), the 10-K's counterpart. Its 6-K
 * is not tracked: 122 of BABA's newest 200 filings are 6-Ks (results,
 * buyback tallies, notices), and none carries a form-level signal. */
export const TRACKED_FORMS: readonly string[] = ['S-1', '424B4', '10-Q', '10-K', '20-F', '8-K']

export function isTrackedForm(form: string): boolean {
  return TRACKED_FORMS.includes(rootForm(form))
}

/** The S-1 family and the 424B4 — the s1-floor rule (layers/terminal/server/pipeline/lanes.ts).
 * Deliberately NOT matched: DRS (confidential drafts are structurally
 * invisible until flipped public — non-goals), S-8, and every periodic form. */
export function isS1FloorForm(form: string): boolean {
  const root = rootForm(form)
  return root === 'S-1' || root === '424B4'
}

/** The periodic reports whose XBRL carries a revenue line (a 20-F's in RMB) —
 * the periodic-floor rule. An 8-K is tracked but left to the judge: it is a
 * material-event notice whose item codes this row does not carry, and most
 * of them are not about the business. */
export function isPeriodicForm(form: string): boolean {
  const root = rootForm(form)
  return root === '10-Q' || root === '10-K' || root === '20-F'
}
