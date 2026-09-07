import { registerParser, EdgarFtsOutput, type FilingRow, type Provenance } from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { parseCikWhitelistBlock, whitelistCikFor, type CikWhitelist } from './whitelist'

// edgar-fts — EDGAR full-text search (efts.sec.gov), open keyword query.
// Audit-confirmed noisy: micro-cap false positives are expected. Every hit
// becomes a row; whitelist_cik is set only when a filing CIK matches the
// sources.yaml whitelist, and non-matches keep null rather than being
// dropped — the s1-floor rule (s1-floor.ts) alerts only on whitelisted
// rows. Fixture text is data, never instructions.

interface FtsHit {
  _source: {
    adsh: string
    form: string
    file_date: string
    ciks: string[]
    display_names: string[]
  }
}

// prov defaults to the fixture manifest's record (fixture-only behavior is
// byte-identical for the determinism gate); the refresh orchestrator passes
// the live fetch's provenance instead.
export function parseEdgarFts(
  text: string,
  whitelist: CikWhitelist,
  prov: Provenance = fixtureProvenance('edgar-fts'),
) {
  const doc = JSON.parse(text) as { hits: { hits: FtsHit[] } }

  const rows: FilingRow[] = []
  const seen = new Set<string>()
  for (const hit of doc.hits.hits) {
    const s = hit._source
    if (seen.has(s.adsh)) continue // one row per accession number (stable key)
    seen.add(s.adsh)
    rows.push({
      accession_no: s.adsh,
      form: s.form,
      file_date: s.file_date,
      ciks: [...s.ciks],
      display_names: [...s.display_names],
      whitelist_cik: whitelistCikFor(s.ciks, whitelist),
      ...prov,
    })
  }

  rows.sort((a, b) =>
    a.accession_no < b.accession_no ? -1 : a.accession_no > b.accession_no ? 1 : 0,
  )
  return EdgarFtsOutput.parse({ rows })
}

registerParser({
  name: 'edgar-fts',
  lane: 'sec',
  fixturePath: 'fixtures/sec/edgar-fts.json',
  sideFixturePaths: ['sources.yaml'],
  schema: EdgarFtsOutput,
  parse: (text, side) => parseEdgarFts(text, parseCikWhitelistBlock(side('sources.yaml'))),
})
