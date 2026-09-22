import {
  registerParser,
  EdgarSubmissionsOutput,
  type FilingRow,
  type ParserId,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { isTrackedForm } from './forms'
import { parseCikWhitelistBlock, whitelistCikFor, type CikWhitelist } from './whitelist'

// edgar-submissions-<ticker> — data.sec.gov/submissions/CIK{n}.json for one
// filer. The payload is columnar (parallel arrays under filings.recent);
// each index whose form is tracked (forms.ts) becomes a FilingRow keyed by
// accession number. The filer's CIK is zero-padded to EDGAR's canonical 10
// digits before whitelist matching — a format normalization, not a lookup.
//
// One parser, five registrations: SPCX (xAI's parent) and the four
// hyperscalers on the CIK whitelist. Each registration is its own source id
// with its own fixture so the determinism gate runs every feed.

interface SubmissionsDoc {
  cik: string
  name: string
  filings: {
    recent: {
      accessionNumber: string[]
      form: string[]
      filingDate: string[]
    }
  }
}

export interface SubmissionsParse {
  rows: FilingRow[]
  /** Rows dropped by the form filter — reported on the run, never silently. */
  skipped: number
}

/** Parse one submissions payload. `prov` is the fetch the text came from. */
export function parseEdgarSubmissions(
  text: string,
  whitelist: CikWhitelist,
  prov: Provenance,
): SubmissionsParse {
  const doc = JSON.parse(text) as SubmissionsDoc
  const cik = String(doc.cik).padStart(10, '0')
  const recent = doc.filings.recent
  const whitelistCik = whitelistCikFor([cik], whitelist)

  const rows: FilingRow[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (let i = 0; i < recent.accessionNumber.length; i++) {
    const accession = recent.accessionNumber[i]!
    const form = recent.form[i]
    const fileDate = recent.filingDate[i]
    if (!form || !fileDate) {
      throw new Error(`submissions arrays misaligned at index ${i} (${accession})`)
    }
    if (!isTrackedForm(form)) {
      skipped++
      continue
    }
    if (seen.has(accession)) continue
    seen.add(accession)
    rows.push({
      accession_no: accession,
      form,
      file_date: fileDate,
      ciks: [cik],
      display_names: [doc.name],
      whitelist_cik: whitelistCik,
      ...prov,
    })
  }

  rows.sort((a, b) =>
    a.accession_no < b.accession_no ? -1 : a.accession_no > b.accession_no ? 1 : 0,
  )
  return { rows: EdgarSubmissionsOutput.parse({ rows }).rows, skipped }
}

/** The five submissions feeds: source id -> committed fixture. */
export const SUBMISSIONS_SOURCES: Readonly<Record<string, string>> = {
  'edgar-submissions-spcx': 'fixtures/sec/edgar-submissions-spcx.json',
  'edgar-submissions-msft': 'fixtures/sec/edgar-submissions-msft.json',
  'edgar-submissions-amzn': 'fixtures/sec/edgar-submissions-amzn.json',
  'edgar-submissions-nvda': 'fixtures/sec/edgar-submissions-nvda.json',
  'edgar-submissions-googl': 'fixtures/sec/edgar-submissions-googl.json',
}

// prov defaults to the fixture manifest's record (fixture-only behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseEdgarSubmissionsSpcx(
  text: string,
  whitelist: CikWhitelist,
  prov: Provenance = fixtureProvenance('edgar-submissions-spcx'),
) {
  return EdgarSubmissionsOutput.parse({ rows: parseEdgarSubmissions(text, whitelist, prov).rows })
}

for (const [sourceId, fixturePath] of Object.entries(SUBMISSIONS_SOURCES)) {
  registerParser({
    name: sourceId as ParserId,
    lane: 'sec',
    fixturePath,
    sideFixturePaths: ['sources.yaml'],
    schema: EdgarSubmissionsOutput,
    parse: (text, side) =>
      EdgarSubmissionsOutput.parse({
        rows: parseEdgarSubmissions(
          text,
          parseCikWhitelistBlock(side('sources.yaml')),
          fixtureProvenance(sourceId),
        ).rows,
      }),
  })
}
