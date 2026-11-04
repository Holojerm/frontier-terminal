import { ProspectusOutput, registerParser, type ParserId, type Provenance } from '../../contracts'
import { fixtureProvenance } from '../fixture-provenance'
import { archivesCik, registrationTarget, type RegistrationTarget } from './filing-index'
import { parseProspectusCommitments } from './prospectus-commitments'
import { parseProspectusConcentration } from './prospectus-concentration'
import { docLines, docText } from './prospectus-doc'
import { parseProspectusOffering } from './prospectus-offering'
import { readStatementTable, revenueFromStatement } from './prospectus-revenue'
import { parseProspectusRiskFactors } from './prospectus-risk-factors'
import { parseProspectusShares } from './prospectus-shares'
import { statementRows } from './prospectus-statement'

// Everything the prospectus-revenue lane reads from one registration
// document: revenue and the cover terms (as before), and the rest of what an
// analyst reads an S-1 for — the whole statement of operations, commitments,
// customer concentration, share counts and the risk-factor headings. One
// parse, one throw: if any part is not the shape its parser expects, the
// document fails as a whole and the run says why, rather than storing a
// filing with some of its parts quietly missing.

/** The amendment the composite parser is gated on (fixtures/manifest.json). */
export const PROSPECTUS_FIXTURE = {
  key: 'anthropic-s-1-a-2026-11-02-0001628280-26-068676',
  sourceId: 'prospectus-revenue-anthropic-s-1-a-2026-11-02-0001628280-26-068676',
  path: 'fixtures/sec/prospectus-anthropic-s-1-a.html',
} as const

export function parseProspectus(
  html: string,
  target: RegistrationTarget,
  cik: string,
  prov: Provenance,
): ProspectusOutput {
  const statement = readStatementTable(html)
  const revenue = revenueFromStatement(statement, target, cik, prov)
  const name = statement.entity_name
  const doc = docText(docLines(html))
  return ProspectusOutput.parse({
    revenue,
    offering: parseProspectusOffering(html, target, cik, name, prov),
    statements: statementRows(statement, target, cik, prov),
    commitments: parseProspectusCommitments(html, doc, target, cik, name, prov),
    concentration: parseProspectusConcentration(html, doc, target, cik, name, prov),
    shares: parseProspectusShares(html, doc, target, cik, name, prov),
    risk_factors: parseProspectusRiskFactors(doc, target, cik, name, prov),
  })
}

registerParser({
  name: PROSPECTUS_FIXTURE.sourceId as ParserId,
  lane: 'sec',
  fixturePath: PROSPECTUS_FIXTURE.path,
  sideFixturePaths: [],
  schema: ProspectusOutput,
  parse: (text) => {
    const prov = fixtureProvenance(PROSPECTUS_FIXTURE.sourceId)
    return parseProspectus(
      text,
      registrationTarget(PROSPECTUS_FIXTURE.key),
      archivesCik(prov.source_url),
      prov,
    )
  },
})
