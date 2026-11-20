// The dependency graph payload (GET /api/dependencies, the /dependencies page,
// the get_dependencies MCP tool) and the layout the page draws it with. A node
// is a company, sized by a figure from its own filing. A line is a figure one
// company's filing puts on another. Shared so the page and the server agree
// on one shape, and so the layout is tested without a browser.

import type { ExposureTicker } from './terminal-exposure'
import type { Prov } from './terminal-types'

/** buys: the customer owes the supplier. funds: the investor backs the lab. */
export type DependencyKind = 'buys' | 'funds'

/** Which filed figure sizes the circles. */
export type DependencyMeasure = 'contracts' | 'capex'

/** One filed number, with the filing it was read from. */
export interface DependencyFigure extends Prov {
  /** The /api/exposure series this is the newest point of; null for a prospectus figure. */
  series_id: string | null
  label: string
  /** A few words for the label on a line. */
  short: string
  value: number
  /** USD, pure (a ratio) or shares. */
  unit: string
  /** Null for a balance. */
  start: string | null
  /** Null when the filing dates the figure only by the filing itself. */
  end: string | null
  /** A flow's length in months; null for a balance. */
  months: number | null
  /** A quarter computed from year-to-date figures (see /api/exposure). */
  derived: boolean
  /** The filing itself calls the figure approximate. */
  approximate: boolean
  note: string | null
  accession_no: string
  form: string
  filed: string
  /** EDGAR's filing index for the accession. */
  filing_url: string
}

export interface DependencyNode {
  id: string
  /** filer: one of the public companies whose XBRL we read. venture: named in a filing, not tracked. */
  kind: 'lab' | 'filer' | 'venture'
  name: string
  ticker: ExposureTicker | null
  /** The tracked lab this company is or owns, for a link to its page. */
  lab: string | null
  /**
   * Contracts on the books: a filer's remaining performance obligations
   * (what customers owe it), a lab's aggregate contractual obligations (what
   * it owes suppliers). Null where the company files neither.
   */
  contracts: DependencyFigure | null
  /** The newest quarter's capex. Null where none is filed. */
  capex: DependencyFigure | null
}

export interface DependencyEdge {
  id: string
  /** buys: the customer. funds: the investor. */
  from: string
  /** buys: the supplier. funds: the lab. */
  to: string
  kind: DependencyKind
  /** The node whose filing states every figure on the line. */
  reporter: string
  /** The dollar figure the line's width follows: the first of `facts` in USD. */
  weight: DependencyFigure | null
  /** Every figure the filer tags on the counterparty for this kind, weight first. */
  facts: DependencyFigure[]
}

export interface DependencyGap {
  id: string
  title: string
  reason: string
}

export interface DependenciesData {
  as_of: string | null
  computed_at: string
  rule: string
  nodes: DependencyNode[]
  edges: DependencyEdge[]
  /** Lines and sizes a reader would look for that no filing we read gives. */
  gaps: DependencyGap[]
  /** Figures a filer tags on a lab that we haven't placed on a line; they are on /exposure. */
  unplaced: { series_id: string; ticker: ExposureTicker; label: string }[]
}

// ─── Layout ─────────────────────────────────────────────────────────────────

export interface LaidOutNode {
  id: string
  x: number
  y: number
  r: number
  /** No figure for the chosen measure: drawn as an outline at the smallest size. */
  hollow: boolean
}

export interface LaidOutEdge {
  id: string
  /** A quadratic curve from the edge of one circle to the edge of the other. */
  d: string
  width: number
  /** Where the label sits: the curve's midpoint. */
  lx: number
  ly: number
}

export interface DependencyLayout {
  width: number
  height: number
  nodes: LaidOutNode[]
  edges: LaidOutEdge[]
}

const ROW = 104
const R_MIN = 6
/** Room under a circle for its two label lines. */
const LABEL = 36
/** How far a line stops short of the circle it points at, for the arrowhead. */
const ARROW = 9
/** How far the two lines between one pair bow apart. */
const BOW = 36
const EDGE_MIN = 1.5
const EDGE_MAX = 6

const round = (n: number) => Math.round(n * 10) / 10

/**
 * Two columns: the labs and ventures on the left, the filers on the right in
 * the order given. A left node sits at the mean height of the filers it has
 * a line to, pushed down where two would overlap. A circle's area follows
 * the chosen figure, against the largest on the graph. Deterministic, so the
 * server and the browser draw the same picture at the same width.
 */
export function layoutDependencies(
  data: Pick<DependenciesData, 'nodes' | 'edges'>,
  measure: DependencyMeasure,
  width: number,
): DependencyLayout {
  const rMax = width < 420 ? 26 : 38
  const side = Math.max(72, Math.round(width * 0.2))
  const top = rMax + 12

  const sizeOf = (n: DependencyNode) => n[measure]?.value ?? null
  const largest = Math.max(0, ...data.nodes.map((n) => sizeOf(n) ?? 0))
  const radius = (n: DependencyNode) => {
    const v = sizeOf(n)
    if (v === null || v <= 0 || largest <= 0) return R_MIN
    return R_MIN + (rMax - R_MIN) * Math.sqrt(v / largest)
  }

  const right = data.nodes.filter((n) => n.kind === 'filer')
  const left = data.nodes.filter((n) => n.kind !== 'filer')
  const placed = new Map<string, LaidOutNode>()
  right.forEach((n, i) => {
    placed.set(n.id, {
      id: n.id,
      x: width - side,
      y: top + i * ROW,
      r: round(radius(n)),
      hollow: sizeOf(n) === null,
    })
  })

  const wanted = left.map((n, i) => {
    const ys = data.edges
      .filter((e) => e.from === n.id || e.to === n.id)
      .map((e) => placed.get(e.from === n.id ? e.to : e.from)?.y)
      .filter((y): y is number => y !== undefined)
    const mean = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity
    return { n, i, mean }
  })
  wanted.sort((a, b) => (a.mean === b.mean ? a.i - b.i : a.mean - b.mean))
  let floor = top
  for (const { n, mean } of wanted) {
    const y = Math.max(floor, Number.isFinite(mean) ? mean : floor)
    placed.set(n.id, {
      id: n.id,
      x: side,
      y: round(y),
      r: round(radius(n)),
      hollow: sizeOf(n) === null,
    })
    floor = y + ROW
  }

  const heaviest = Math.max(0, ...data.edges.map((e) => e.weight?.value ?? 0))
  const pairs = new Map<string, number>()
  for (const e of data.edges) {
    const k = [e.from, e.to].sort().join('|')
    pairs.set(k, (pairs.get(k) ?? 0) + 1)
  }

  const edges: LaidOutEdge[] = []
  for (const e of data.edges) {
    const a = placed.get(e.from)
    const b = placed.get(e.to)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    // The two lines of a pair bow to opposite sides. The normal is taken
    // left to right so both lines of a pair agree on which side is which.
    const sign = a.x <= b.x ? 1 : -1
    const nx = (-dy / len) * sign
    const ny = (dx / len) * sign
    const both = (pairs.get([e.from, e.to].sort().join('|')) ?? 1) > 1
    const bow = both ? (e.kind === 'buys' ? -BOW : BOW) : 0
    const cx = (a.x + b.x) / 2 + nx * bow
    const cy = (a.y + b.y) / 2 + ny * bow
    const toward = (p: LaidOutNode, gap: number) => {
      const ux = cx - p.x
      const uy = cy - p.y
      const ul = Math.hypot(ux, uy) || 1
      return { x: p.x + (ux / ul) * (p.r + gap), y: p.y + (uy / ul) * (p.r + gap) }
    }
    const p0 = toward(a, 2)
    const p1 = toward(b, ARROW)
    const w = e.weight?.value ?? 0
    edges.push({
      id: e.id,
      d: `M${round(p0.x)},${round(p0.y)} Q${round(cx)},${round(cy)} ${round(p1.x)},${round(p1.y)}`,
      width: round(
        heaviest > 0 && w > 0 ? EDGE_MIN + (EDGE_MAX - EDGE_MIN) * (w / heaviest) : EDGE_MIN,
      ),
      lx: round(0.25 * p0.x + 0.5 * cx + 0.25 * p1.x),
      ly: round(0.25 * p0.y + 0.5 * cy + 0.25 * p1.y),
    })
  }

  const nodes = data.nodes.map((n) => placed.get(n.id)!).filter(Boolean)
  const bottom = Math.max(top, ...nodes.map((n) => n.y + n.r))
  return { width, height: Math.round(bottom + LABEL + 8), nodes, edges }
}

/** `quarter to 2026-09-30`, `at 2026-09-30`, `9 months to …`; empty when the filing gives no date. */
export function figurePeriod(f: Pick<DependencyFigure, 'months' | 'end'>): string {
  if (f.end === null) return ''
  if (f.months === null) return `at ${f.end}`
  return f.months === 3 ? `quarter to ${f.end}` : `${f.months} months to ${f.end}`
}
