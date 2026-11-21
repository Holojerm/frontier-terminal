import {
  PROSPECTUS_PARTS,
  ProspectusOutput,
  registerParser,
  type ParserId,
  type ProspectusPart,
  type Provenance,
} from '#layers/core/server/utils/contracts'
import { fixtureProvenance } from '#layers/core/server/utils/fixture-provenance'
import { archivesCik, cellText, registrationTarget, type RegistrationTarget } from './filing-index'
import { parseProspectusCommitments } from './prospectus-commitments'
import { parseProspectusConcentration } from './prospectus-concentration'
import { docLines, docText } from './prospectus-doc'
import { parseProspectusOffering } from './prospectus-offering'
import { readStatementTable, revenueFromStatement } from './prospectus-revenue'
import { parseProspectusRiskFactors } from './prospectus-risk-factors'
import { parseProspectusShares } from './prospectus-shares'
import { statementRows } from './prospectus-statement'

// Everything the prospectus-revenue lane reads from one registration document.
// Each part is parsed on its own: a part its parser can't read is left empty and
// named in `failed`, and the rest are stored, so one reworded sentence can't hold
// back revenue. The lane reads the document again next tick
// (refresh.ts › ParseResult.problems), and only a document where every part fails
// is a failed run.

/** The amendment the composite parser is gated on (fixtures/manifest.json). */
export const PROSPECTUS_FIXTURE = {
  key: 'anthropic-s-1-a-2026-11-02-0001628280-26-068676',
  sourceId: 'prospectus-revenue-anthropic-s-1-a-2026-11-02-0001628280-26-068676',
  path: 'fixtures/sec/prospectus-anthropic-s-1-a.html',
} as const

const COVER_NAME = /SECURITIES ACT OF 1933 (.{2,120}?) \(Exact name of registrant/i

/** The registrant as the facing page names it, for when the statement cannot be read. */
export function coverName(html: string): string | null {
  return cellText(html.slice(0, 200_000)).match(COVER_NAME)?.[1]?.trim() || null
}

export function parseProspectus(
  html: string,
  target: RegistrationTarget,
  cik: string,
  prov: Provenance,
): ProspectusOutput {
  const failed: ProspectusOutput['failed'] = []
  const part = <T>(name: ProspectusPart, empty: T, read: () => T): T => {
    try {
      return read()
    } catch (error) {
      failed.push({ part: name, error: error instanceof Error ? error.message : String(error) })
      return empty
    }
  }
  // Revenue and the statement lines both come from the statement of operations.
  const statement = part('statements', null, () => readStatementTable(html))
  if (!statement) failed.push({ part: 'revenue', error: failed[0]!.error })
  const name = statement?.entity_name ?? coverName(html)
  if (!name) {
    throw new Error(
      `neither the statement nor the facing page names the registrant: ${failed[0]?.error}`,
    )
  }
  const doc = docText(docLines(html))
  const out = {
    revenue: statement
      ? part('revenue', [], () => revenueFromStatement(statement, target, cik, prov))
      : [],
    offering: part('offering', null, () => parseProspectusOffering(html, target, cik, name, prov)),
    statements: statement
      ? part('statements', [], () => statementRows(statement, target, cik, prov))
      : [],
    commitments: part('commitments', [], () =>
      parseProspectusCommitments(html, doc, target, cik, name, prov),
    ),
    concentration: part('concentration', [], () =>
      parseProspectusConcentration(html, doc, target, cik, name, prov),
    ),
    shares: part('shares', null, () => parseProspectusShares(html, doc, target, cik, name, prov)),
    risk_factors: part('risk_factors', null, () =>
      parseProspectusRiskFactors(doc, target, cik, name, prov),
    ),
  }
  if (new Set(failed.map((f) => f.part)).size === PROSPECTUS_PARTS.length) {
    throw new Error(`no part of the document parsed: ${failed.map((f) => f.error).join('; ')}`)
  }
  return ProspectusOutput.parse({ ...out, failed })
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
