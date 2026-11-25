// The tear sheet's listed-company panels: open roles on their job boards and what their
// management guided on earnings calls. Which companies a lab's sheet carries is the
// listed table's rule, applied on the server (`?lab=` on both routes,
// layers/terminal/server/utils/terminal-listed-ties.ts): the lab or its listed parent, a
// company a filing or cited page names beside the lab, or one whose power site the lab
// uses. So these panels name only companies the sheet's Listed companies table lists.

export interface SheetBoard {
  key: string
  ticker: string
  company: string
  /** Null on a board read for its data-center roles only. */
  open: string | null
  datacenter: string
  /** Against the newest week before, or why there is none. */
  change: string
  read: string
  ref: number | null
  gap: SheetGap | null
}

export interface SheetCall {
  ticker: string
  company: string
  scored: string
  results: string
  /** The newest scored figure: what was guided, what was filed, how it landed. */
  newest: string | null
  refs: number[]
  gap: SheetGap | null
}

export interface SheetListedPanels {
  boards: { rows: SheetBoard[]; notes: string[]; gap: SheetGap | null }
  calls: { rows: SheetCall[]; summary: string | null; gap: SheetGap | null }
  caveats: SheetCaveat[]
}

export interface ListedPanelInputs {
  /** /api/hiring/listed?lab=, each board cut to its newest week. */
  listedHiring?: Pick<ListedHiringData, 'boards' | 'cut' | 'rule'> | null
  /** /api/call-guidance?lab=, cut by callsInput to the scored statements. */
  calls?: Pick<CallGuidanceData, 'statements' | 'tally' | 'companies' | 'rule'> | null
}

type Cite = (prov: Prov, label: string) => number

const day = (iso: string) => iso.slice(0, 10)
const scoredState = (s: CallStatement) =>
  s.state === 'met' || s.state === 'above' || s.state === 'below'

/** The useFetch transform: scored statements only, without the quotes the sheet doesn't print. */
export function callsInput(d: CallGuidanceData): NonNullable<ListedPanelInputs['calls']> {
  return {
    statements: d.statements.filter(scoredState).map((s) => ({ ...s, quote: '' })),
    tally: d.tally,
    companies: d.companies,
    rule: d.rule,
  }
}

function boardRow(b: ListedHiringBoard, cite: Cite): SheetBoard {
  const base = { key: b.id, ticker: b.ticker, company: b.company }
  if (!b.latest) {
    return {
      ...base,
      open: null,
      datacenter: '',
      change: '',
      read: '',
      ref: null,
      gap: {
        title: 'Not read yet',
        reason: b.failing ? `Our newest read failed on ${day(b.failing.read_at)}.` : null,
      },
    }
  }
  const week = b.weeks.at(-1)
  const moves = week
    ? [
        ...(week.total_change === null ? [] : [`${signed(week.total_change)} open`]),
        ...(week.datacenter_change === null
          ? []
          : [`${signed(week.datacenter_change)} data-center`]),
      ]
    : []
  return {
    ...base,
    open: b.latest.total === null ? null : count(b.latest.total),
    datacenter: count(b.latest.datacenter),
    change: moves.length ? moves.join(', ') : 'First week on record',
    // A failing board keeps its last good count; the read date says how old it is.
    read: b.failing
      ? `${day(b.latest.read_at)}, failing since ${day(b.failing.read_at)}`
      : day(b.latest.read_at),
    ref: cite(b.latest, `${b.company} job board`),
    gap: null,
  }
}

function boardsSection(display: string, data: ListedPanelInputs['listedHiring'], cite: Cite) {
  const boards = data?.boards ?? []
  const rows = boards.map((b) => boardRow(b, cite))
  const notes = [
    ...boards
      .filter((b) => b.scope === 'datacenter')
      .map((b) => `${b.company}: we read only its data-center roles, so there is no total.`),
    ...boards.flatMap((b) => (b.caveat ? [`${b.company}: ${b.caveat}`] : [])),
    ...(data?.cut ?? []).map((c) => `${c.company} (${c.ticker}): ${c.reason}`),
  ]
  return {
    rows,
    notes,
    gap:
      rows.length || notes.length
        ? null
        : {
            title: 'No board read',
            reason: `We read no job board of a listed company tied to ${display}.`,
          },
  }
}

function callRow(c: CallCoverage, statements: readonly CallStatement[], cite: Cite): SheetCall {
  const base = { ticker: c.ticker, company: c.company }
  if (c.statements === 0) {
    return {
      ...base,
      scored: '',
      results: '',
      newest: null,
      refs: [],
      gap: {
        title: 'No guidance read',
        // Not the coverage line (c.gap): that says how its calls are read, which /ground-truth prints.
        reason: `We haven’t stored a guided figure from ${c.company}’s calls yet.`,
      },
    }
  }
  const own = statements.filter((s) => s.ticker === c.ticker)
  const n = (state: CallStatement['state']) => own.filter((s) => s.state === state).length
  // Statements arrive newest call first.
  const s = own.find((x) => x.actual !== null) ?? null
  const refs: number[] = []
  if (s?.sources[0]) {
    refs.push(
      cite(
        { source_url: s.sources[0].url, fetched_at: s.first_seen_at },
        `${c.ticker} call, ${s.call_date}`,
      ),
    )
  }
  if (s?.actual) {
    refs.push(
      cite(
        { source_url: s.actual.filing_url, fetched_at: s.actual.first_seen_at },
        `${c.ticker} ${s.actual.form} filed ${s.actual.filed}`,
      ),
    )
  }
  return {
    ...base,
    scored: `${count(c.scored)} of ${count(c.statements)}`,
    results: c.scored
      ? `${n('met')} met, ${n('above')} above, ${n('below')} below`
      : 'None filed yet',
    newest: s?.actual
      ? `${callWhat(s)}, ${s.period}: guided ${callGuided(s).replace(/^At /, 'at ')}, filed ${callValue(s.actual.value, s.unit)}. ${callResult(s)}.`
      : null,
    refs,
    gap: null,
  }
}

function callsSection(display: string, data: ListedPanelInputs['calls'], cite: Cite) {
  const rows = (data?.companies ?? []).map((c) => callRow(c, data!.statements, cite))
  const t = data?.tally
  const summary =
    t && t.statements
      ? `${count(t.scored)} of ${count(t.statements)} guided figures scored against a later filing: ${t.met} met, ${t.above} above, ${t.below} below.${
          t.median_abs_error === null
            ? ''
            : ` Median miss on dollar figures ${percent(t.median_abs_error * 100)}.`
        }`
      : null
  return {
    rows,
    summary,
    gap: rows.length
      ? null
      : {
          title: 'No call read',
          reason: `We read the earnings calls of no listed company tied to ${display}.`,
        },
  }
}

/** The listed-company panels for one lab, citing into the sheet's one source list. */
export function buildListedPanels(
  display: string,
  input: ListedPanelInputs,
  cite: Cite,
): SheetListedPanels {
  const caveats: SheetCaveat[] = []
  const boards = boardsSection(display, input.listedHiring, cite)
  if (input.listedHiring && boards.rows.some((r) => r.gap === null)) {
    caveats.push({ label: 'Listed-company hiring', text: input.listedHiring.rule })
  }
  const calls = callsSection(display, input.calls, cite)
  if (input.calls && calls.summary) caveats.push({ label: 'Call guidance', text: input.calls.rule })
  return { boards, calls, caveats }
}
