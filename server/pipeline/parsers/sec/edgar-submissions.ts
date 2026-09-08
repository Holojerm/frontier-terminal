import {
  registerParser,
  EdgarSubmissionsOutput,
  type FilingRow,
  type Provenance,
} from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { parseCikWhitelistBlock, whitelistCikFor, type CikWhitelist } from './whitelist'

// edgar-submissions-spcx — data.sec.gov/submissions/CIK{n}.json for one
// filer (SPCX). The payload is columnar (parallel arrays under
// filings.recent); each index becomes a FilingRow keyed by accession
// number. The filer's CIK is zero-padded to EDGAR's canonical 10 digits
// before whitelist matching — a format normalization, not a lookup.

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

// prov defaults to the fixture manifest's record (fixture-only behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseEdgarSubmissionsSpcx(
  text: string,
  whitelist: CikWhitelist,
  prov: Provenance = fixtureProvenance('edgar-submissions-spcx'),
) {
  const doc = JSON.parse(text) as SubmissionsDoc
  const cik = String(doc.cik).padStart(10, '0')
  const recent = doc.filings.recent
  const whitelistCik = whitelistCikFor([cik], whitelist)

  const rows: FilingRow[] = []
  const seen = new Set<string>()
  for (let i = 0; i < recent.accessionNumber.length; i++) {
    const accession = recent.accessionNumber[i]!
    if (seen.has(accession)) continue
    seen.add(accession)
    const form = recent.form[i]
    const fileDate = recent.filingDate[i]
    if (!form || !fileDate) {
      throw new Error(`submissions arrays misaligned at index ${i} (${accession})`)
    }
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
  return EdgarSubmissionsOutput.parse({ rows })
}

registerParser({
  name: 'edgar-submissions-spcx',
  lane: 'sec',
  fixturePath: 'fixtures/sec/edgar-submissions-spcx.json',
  sideFixturePaths: ['sources.yaml'],
  schema: EdgarSubmissionsOutput,
  parse: (text, side) =>
    parseEdgarSubmissionsSpcx(text, parseCikWhitelistBlock(side('sources.yaml'))),
})
