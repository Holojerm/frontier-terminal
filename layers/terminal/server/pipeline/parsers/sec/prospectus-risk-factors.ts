import { RiskFactorsRow, type Provenance } from '../../contracts'
import type { RegistrationTarget } from './filing-index'
import type { DocLine, DocText } from './prospectus-doc'

// Every risk-factor heading a registration document prints, in order, under
// the "Risks Related to …" subsection it sits in. In a Workiva prospectus the
// section opens on a display-size bold "Risk Factors" line and runs to the
// next display-size title; a subsection is a bold, upright line between body
// and display size; a heading is a run of lines whose every font is bold
// italic. Page furniture (a page number, "Table of Contents") sits inside a
// heading that crosses a page and is skipped; any other line ends it.
//
// What an amendment added, removed or reworded is a comparison between two
// filings' rows — riskFactorChanges() below — not something one document says.

const TITLE_PT = 14
const BODY_MAX_PT = 11
/** Fewer than this many headings is a section the parser did not understand. */
const MIN_HEADINGS = 5

const isTitle = (l: DocLine) => l.bold && !l.italic && l.size >= TITLE_PT
const isSubsection = (l: DocLine) =>
  l.bold && !l.italic && l.size > BODY_MAX_PT && l.size < TITLE_PT
const isHeadingLine = (l: DocLine) => l.bold && l.italic && l.size > 0 && l.size <= BODY_MAX_PT
const isFurniture = (l: DocLine) => /^\d{1,3}$/.test(l.text) || l.text === 'Table of Contents'

export function parseProspectusRiskFactors(
  doc: DocText,
  target: RegistrationTarget,
  cik: string,
  entityName: string,
  prov: Provenance,
): RiskFactorsRow {
  const start = doc.lines.findIndex((l) => isTitle(l) && l.text === 'Risk Factors')
  if (start === -1) throw new Error('no Risk Factors section')
  const stop = doc.lines.findIndex((l, i) => i > start && isTitle(l))
  if (stop === -1) throw new Error('the Risk Factors section does not end')

  const sections: { title: string; headings: string[] }[] = []
  let current: string[] = []
  const flush = () => {
    if (!current.length) return
    if (!sections.length) sections.push({ title: 'Risk Factors', headings: [] })
    sections.at(-1)!.headings.push(current.join(' ').replace(/\s+/g, ' ').trim())
    current = []
  }
  for (const line of doc.lines.slice(start + 1, stop)) {
    if (isSubsection(line)) {
      flush()
      sections.push({ title: line.text, headings: [] })
    } else if (isHeadingLine(line)) current.push(line.text)
    else if (!isFurniture(line)) flush()
  }
  flush()

  const empty = sections.filter((s) => !s.headings.length).map((s) => s.title)
  if (empty.length) throw new Error(`risk-factor subsections with no headings: ${empty.join('; ')}`)
  const total = sections.reduce((n, s) => n + s.headings.length, 0)
  if (total < MIN_HEADINGS) throw new Error(`the Risk Factors section yields ${total} headings`)

  return RiskFactorsRow.parse({
    provider: target.provider,
    cik,
    entity_name: entityName,
    accession_no: target.accession_no,
    form: target.form,
    filed: target.filed,
    sections,
    ...prov,
  })
}

// ── between two filings ─────────────────────────────────────────────────────

export interface RiskFactorChange {
  kind: 'added' | 'removed' | 'reworded'
  /** The subsection in the later filing (the earlier one for a removal). */
  section: string
  heading: string
  /** For a rewording: the earlier filing's words. */
  previous: string | null
}

/** Rewordings this close share most of their words: a comma, "the" for "our". */
const REWORDED_AT = 0.75

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? [])

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / (a.size + b.size - shared || 1)
}

const flat = (row: Pick<RiskFactorsRow, 'sections'>) =>
  row.sections.flatMap((s) => s.headings.map((heading) => ({ section: s.title, heading })))

/**
 * What the later filing's headings did to the earlier one's: identical text
 * is unchanged and not listed; a heading whose words mostly survive is
 * reworded (paired best match first); the rest were added or removed.
 */
export function riskFactorChanges(
  before: Pick<RiskFactorsRow, 'sections'>,
  after: Pick<RiskFactorsRow, 'sections'>,
): RiskFactorChange[] {
  const was = flat(before)
  const now = flat(after)
  const kept = new Set(was.map((h) => h.heading))
  const stays = new Set(now.map((h) => h.heading))
  const gone = was.filter((h) => !stays.has(h.heading))
  const fresh = now.filter((h) => !kept.has(h.heading))

  const pairs = fresh
    .flatMap((n, i) =>
      gone.map((g, j) => ({ i, j, score: similarity(words(n.heading), words(g.heading)) })),
    )
    .filter((p) => p.score >= REWORDED_AT)
    .sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j)
  const pairedNew = new Map<number, number>()
  const pairedOld = new Set<number>()
  for (const p of pairs) {
    if (pairedNew.has(p.i) || pairedOld.has(p.j)) continue
    pairedNew.set(p.i, p.j)
    pairedOld.add(p.j)
  }

  const changes: RiskFactorChange[] = fresh.map((n, i) => {
    const j = pairedNew.get(i)
    return j === undefined
      ? { kind: 'added', section: n.section, heading: n.heading, previous: null }
      : { kind: 'reworded', section: n.section, heading: n.heading, previous: gone[j]!.heading }
  })
  gone.forEach((g, j) => {
    if (!pairedOld.has(j)) {
      changes.push({ kind: 'removed', section: g.section, heading: g.heading, previous: null })
    }
  })
  return changes
}
