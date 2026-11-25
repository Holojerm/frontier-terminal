// The tear sheet's lab-page panels: new SKUs, implied spend share, measured strain and
// misalignment disclosures. Each reads the lab page's payload narrowed to one lab and
// prints what that panel shows, cut to what fits on paper. A lab a dataset doesn't cover
// gets a stated gap, never a zero.

/** How many new SKUs the sheet lists, newest first; the rest are on the lab page. */
export const SHEET_RELEASES = 5

export interface SheetRelease {
  key: string
  date: string
  model: string
  tier: string | null
  input: string
  output: string
  ref: number
}

/** What the sheet reads from /api/releases: the lab's newest SKUs, and how many it has. */
export interface SheetReleasesInput {
  rows: ReleaseView[]
  total: number
  log_from: string | null
}

export interface SheetPanels {
  releases: { rows: SheetRelease[]; more: number; gap: SheetGap | null }
  /** Implied spend share, read beside the OpenRouter share. */
  spend: SheetFigure
  probes: SheetFigure
  disclosures: SheetFigure
  caveats: SheetCaveat[]
}

export interface PanelInputs {
  /** /api/releases, narrowed and capped by releasesInput. */
  releases?: SheetReleasesInput | null
  /** /api/spend narrowed to the lab; the rankings keep only their provenance. */
  spend?:
    | (Pick<SpendData, 'status' | 'window' | 'providers' | 'excluded' | 'caveat'> & {
        rankings: Pick<SpendData['rankings'], 'provenance'>
      })
    | null
  /** /api/probes?lab=, each day list cut to its newest complete day. */
  probes?: Pick<ProbesData, 'labs' | 'placement' | 'caveat'> | null
  /** /api/disclosures?lab=, without its entries. */
  disclosures?: Pick<DisclosuresData, 'providers'> | null
}

type Cite = (prov: Prov, label: string) => number

const day = (iso: string) => iso.slice(0, 10)
const gapFigure = (label: string, title: string, reason: string | null = null): SheetFigure => ({
  label,
  value: null,
  delta: null,
  lines: [],
  gap: { title, reason },
  ref: null,
})

/** The useFetch transform: the lab's newest SHEET_RELEASES SKUs and its count. */
export function releasesInput(d: ReleasesData, lab: LabId): SheetReleasesInput {
  const rows = d.rows.filter((r) => r.provider === lab)
  return { rows: rows.slice(0, SHEET_RELEASES), total: rows.length, log_from: d.log_from }
}

function releasesSection(display: string, input: SheetReleasesInput | null, cite: Cite) {
  const rows: SheetRelease[] = (input?.rows ?? []).slice(0, SHEET_RELEASES).map((r) => ({
    key: r.change_id,
    date: day(r.first_seen_at),
    model: r.model_slug,
    tier: r.tier,
    input: money(r.input_per_mtok),
    output: money(r.output_per_mtok),
    ref: cite(r, `${display} pricing`),
  }))
  const since = input?.log_from ? ` since we began reading its pages, ${day(input.log_from)}` : ''
  return {
    rows,
    more: Math.max(0, (input?.total ?? 0) - rows.length),
    gap: rows.length
      ? null
      : {
          title: 'No new SKU since tracking began',
          reason: `No price page we read has listed a new ${display} SKU${since}.`,
        },
  }
}

const SPEND_LABEL = 'Implied share of priced labs’ spend'

// Dollars are ordered by construction (input ≤ output price); a share is not, so sort both ends.
function span(a: number, b: number, f: (n: number) => string): string {
  const [low, high] = a <= b ? [a, b] : [b, a]
  return f(low) === f(high) ? f(low) : `${f(low)}–${f(high)}`
}

function spendFigure(
  lab: LabId,
  display: string,
  spend: PanelInputs['spend'],
  cite: Cite,
): SheetFigure {
  if (!spend) return gapFigure(SPEND_LABEL, 'No spend data yet')
  if (spend.status !== 'ok') return gapFigure(SPEND_LABEL, 'No rankings data yet')
  const excluded = spend.excluded.find((e) => e.provider === lab)
  if (excluded) return gapFigure(SPEND_LABEL, 'Not priceable', excluded.reason)
  const p = spend.providers.find((x) => x.provider === lab)
  const window = spend.window ? `${spend.window.from} to ${spend.window.to}` : 'the window'
  if (!p || p.tokens === 0) {
    return gapFigure(
      SPEND_LABEL,
      'No tokens in the window',
      `OpenRouter routed no ${display} tokens ${window}.`,
    )
  }
  if (p.share_low === null || p.share_high === null || p.priced_tokens === 0) {
    return gapFigure(
      SPEND_LABEL,
      'Not priceable',
      `No ${display} model on OpenRouter matched a priced SKU.`,
    )
  }
  // Each bound is the rankings' tokens times a list price, so both reads are footnoted.
  const ref = spend.rankings.provenance
    ? cite(spend.rankings.provenance, 'OpenRouter rankings')
    : null
  const prices = [
    ...new Set(
      p.models.flatMap((m) =>
        m.price_source_url && m.price_fetched_at
          ? [
              cite(
                { source_url: m.price_source_url, fetched_at: m.price_fetched_at },
                `${display} pricing`,
              ),
            ]
          : [],
      ),
    ),
  ].sort((a, b) => a - b)
  return {
    label: SPEND_LABEL,
    value: span(p.share_low, p.share_high, sharePct),
    delta: null,
    lines: [
      `${span(p.spend_low, p.spend_high, compactUsd)} at list prices, ${window}: all tokens at the input price to all at the output price.`,
      `${sharePct(p.coverage)} of its tokens matched a priced SKU.`,
    ],
    gap: null,
    ref,
    refs: prices,
  }
}

function probesFigure(display: string, probes: PanelInputs['probes'], lab: LabId, cite: Cite) {
  const label = 'Probes rate limited or failed'
  if (!probes) return gapFigure(label, 'No probe data yet')
  const row = probes.labs.find((l) => l.lab === lab)
  if (!row || row.status === 'not_probed') return gapFigure(label, 'Not probed', row?.gap ?? null)
  if (row.status === 'waiting') return gapFigure(label, 'No probe yet', row.gap)
  // The current UTC day is still coming in, so the figure is the newest whole day.
  const d = row.days.find((x) => x.complete)
  if (!d) {
    return gapFigure(
      label,
      'First full day pending',
      row.other_series.length
        ? `Probes now leave from one place, in ${probes.placement.label}. A reading needs one complete UTC day from there; earlier probes are kept apart.`
        : 'A reading needs one complete UTC day of probes. The first probes are in.',
    )
  }
  if (d.strained_share === null) return gapFigure(`${label}, ${d.day}`, 'No probe counted', null)
  const model = d.model.slice(d.model.indexOf('/') + 1)
  const speeds =
    d.peak_tps !== null && d.offpeak_tps !== null
      ? [
          `${grouped(d.peak_tps, 1)} tokens/s in working hours, ${grouped(d.offpeak_tps, 1)} at night${row.hours ? ` (${row.hours})` : ''}.`,
        ]
      : []
  return {
    label: `${label}, ${d.day}`,
    value: sharePct(d.strained_share),
    delta:
      d.peak_to_offpeak === null
        ? null
        : `${pctLabel((d.peak_to_offpeak - 1) * 100)} peak speed vs off-peak`,
    lines: [
      `${count(d.probes)} hourly probes of ${model}: ${count(d.rate_limited)} rate limited, ${count(d.failed)} failed.`,
      ...speeds,
    ],
    gap: null,
    ref: cite(d, `Our hourly probes of ${display}`),
  }
}

function disclosuresFigure(
  display: string,
  data: PanelInputs['disclosures'],
  lab: LabId,
  cite: Cite,
): SheetFigure {
  const label = 'Misalignment reports on its own index'
  const p = data?.providers.find((x) => x.provider === lab)
  if (!p) return gapFigure(label, 'No disclosure data yet')
  const gap = feedGap('disclosures', p)
  if (gap) return gapFigure(label, gap.title, gap.reason ?? null)
  const source = p.sources[0] ?? null
  const median = p.median_days_to_disclosure
  return {
    label,
    value: count(p.reports),
    delta: null,
    lines: [
      `And ${count(p.notices)} ${p.notices === 1 ? 'notice' : 'notices'}.`,
      median === null
        ? 'No report prints both its discovery and publication dates.'
        : `Median ${trimmed(median)} days from discovery to publication, over ${count(p.timed_reports)} ${p.timed_reports === 1 ? 'report' : 'reports'}.`,
    ],
    gap: null,
    ref: source ? cite(source, source.label || `${display} disclosures`) : null,
  }
}

/** The lab-page panels for one lab, citing into the sheet's one source list. */
export function buildLabPanels(
  lab: LabId,
  display: string,
  input: PanelInputs,
  cite: Cite,
): SheetPanels {
  const caveats: SheetCaveat[] = []
  const releases = releasesSection(display, input.releases ?? null, cite)
  const spend = spendFigure(lab, display, input.spend, cite)
  if (input.spend && spend.value !== null) {
    caveats.push({ label: 'Implied spend', text: input.spend.caveat })
  }
  const probes = probesFigure(display, input.probes, lab, cite)
  if (input.probes && probes.value !== null) {
    caveats.push({ label: 'Probes', text: input.probes.caveat })
  }
  const disclosures = disclosuresFigure(display, input.disclosures, lab, cite)
  const own = input.disclosures?.providers.find((p) => p.provider === lab)
  if (disclosures.value !== null && own?.caveat) {
    caveats.push({ label: 'Disclosures', text: own.caveat })
  }
  return { releases, spend, probes, disclosures, caveats }
}
