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

/** The S-1 family and the 424B4 — the s1-floor rule (layers/terminal/server/pipeline/filing-floors.ts).
 * Deliberately NOT matched: DRS (confidential drafts are structurally
 * invisible until flipped public — non-goals), S-8, and every periodic form. */
export function isS1FloorForm(form: string): boolean {
  const root = rootForm(form)
  return root === 'S-1' || root === '424B4'
}

/** Form 8-K's item captions, so an alert can say what a filing is about and
 * the grounding gate finds the words in the record. */
const EIGHT_K_ITEMS: Readonly<Record<string, string>> = {
  '1.01': 'Entry into a Material Definitive Agreement',
  '1.02': 'Termination of a Material Definitive Agreement',
  '1.03': 'Bankruptcy or Receivership',
  '1.05': 'Material Cybersecurity Incidents',
  '2.01': 'Completion of Acquisition or Disposition of Assets',
  '2.02': 'Results of Operations and Financial Condition',
  '2.03': 'Creation of a Direct Financial Obligation',
  '2.04': 'Triggering Events That Accelerate a Financial Obligation',
  '2.05': 'Costs Associated with Exit or Disposal Activities',
  '2.06': 'Material Impairments',
  '3.01': 'Notice of Delisting',
  '3.02': 'Unregistered Sales of Equity Securities',
  '3.03': 'Material Modification to Rights of Security Holders',
  '4.01': "Changes in Registrant's Certifying Accountant",
  '4.02': 'Non-Reliance on Previously Issued Financial Statements',
  '5.01': 'Changes in Control of Registrant',
  '5.02': 'Departure or Appointment of Directors or Certain Officers',
  '5.03': 'Amendments to Articles of Incorporation or Bylaws',
  '5.05': 'Amendments to the Code of Ethics',
  '5.07': 'Submission of Matters to a Vote of Security Holders',
  '7.01': 'Regulation FD Disclosure',
  '8.01': 'Other Events',
  '9.01': 'Financial Statements and Exhibits',
}

/** Governance housekeeping, investor-deck furnishing, a catch-all and the
 * exhibit list: an 8-K carrying only these is a ticker line. */
const ROUTINE_8K_ITEMS: ReadonlySet<string> = new Set([
  '5.03',
  '5.05',
  '5.07',
  '7.01',
  '8.01',
  '9.01',
])

/** EDGAR's "2.02,9.01" as captioned items; an unknown number stays bare. */
export function eightKItems(raw: string): string[] {
  return raw
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean)
    .map((code) => (EIGHT_K_ITEMS[code] ? `${code} ${EIGHT_K_ITEMS[code]}` : code))
}

export function isRoutine8K(items: readonly string[]): boolean {
  return items.length > 0 && items.every((i) => ROUTINE_8K_ITEMS.has(i.split(' ')[0]!))
}

/** The periodic reports whose XBRL carries a revenue line (a 20-F's in RMB) —
 * the periodic-floor rule. An 8-K is tracked but left to the judge: it is a
 * material-event notice, and most of them are not about the business. */
export function isPeriodicForm(form: string): boolean {
  const root = rootForm(form)
  return root === '10-Q' || root === '10-K' || root === '20-F'
}
