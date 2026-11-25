// The tear sheet's recipe-read sections: enterprise adoption and package downloads,
// posted pay, data-center power and published rate limits. Each is the lab page's
// payload narrowed to one lab, printed as the recipe stored it, with the caveat its
// route carries. A lab a recipe doesn't read gets a stated gap, never a zero.

/** The caveats a printed page has to carry beside a recipe's numbers, one per dataset shown. */
export interface SheetCaveat {
  label: string
  text: string
}

export interface SheetDownload {
  key: string
  package: string
  registry: string
  kind: 'SDK' | 'Agent'
  /** Null when fewer than 28 days are on record; the row states the gap. */
  last: string | null
  /** Against the 28 days before, or '—' when there is no full prior window. */
  change: string
  through: string
  ref: number | null
}

export interface SheetPay {
  key: string
  label: string
  median: string
  range: string
  bands: string
  change: string
  ref: number
}

export interface SheetLimitPage {
  key: string
  covers: string
  limits: string
  change: string
  ref: number
}

export interface SheetRecipes {
  /** Ramp's share for the lab, then each coding agent's public PRs. Read beside OpenRouter demand. */
  adoption: SheetFigure[]
  downloads: { rows: SheetDownload[]; gap: SheetGap | null }
  pay: { rows: SheetPay[]; gap: SheetGap | null }
  power: SheetFigure
  limits: { rows: SheetLimitPage[]; gap: SheetGap | null }
  caveats: SheetCaveat[]
  /** Upstream attribution a source requires, verbatim. */
  citations: string[]
}

export interface RecipeInputs {
  adoption?: Pick<AdoptionData, 'ramp' | 'downloads' | 'agent_prs' | 'caveats'> | null
  pay?: Pick<PayData, 'boards' | 'caveat'> | null
  limits?: { pages: Omit<LimitsData['pages'][number], 'archived'>[]; caveat: string } | null
  datacenters?: Pick<
    DataCentersData,
    'snapshot' | 'labs' | 'speculative_only' | 'source' | 'caveat'
  > | null
}

type Cite = (prov: Prov, label: string) => number

const EPOCH_LICENSE = 'Data-center power: CC BY 4.0, Epoch AI.'

const sites = (n: number) => `${count(n)} ${n === 1 ? 'site' : 'sites'}`

const gapFigure = (label: string, title: string, reason: string | null = null): SheetFigure => ({
  label,
  value: null,
  delta: null,
  lines: [],
  gap: { title, reason },
  ref: null,
})

const RAMP_LABEL = 'US businesses on Ramp paying it'

function rampFigure(
  lab: LabId,
  display: string,
  ramp: AdoptionData['ramp'] | undefined,
  cite: Cite,
): SheetFigure {
  if (!ramp) return gapFigure(RAMP_LABEL, 'No Ramp release stored yet')
  const series = ramp.series.find((s) => s.lab === lab)
  if (!series) {
    return gapFigure(RAMP_LABEL, 'Not in Ramp’s vendor series', `Ramp reports no ${display} line.`)
  }
  const n = ramp.months.length
  const now = series.values[n - 1] ?? null
  if (now === null) {
    return gapFigure(RAMP_LABEL, 'No figure for the newest month', 'Ramp’s newest month is blank.')
  }
  const year = n > 12 ? (series.values[n - 13] ?? null) : null
  const overall = ramp.series.find((s) => s.key === 'overall')?.values[n - 1] ?? null
  return {
    label: RAMP_LABEL,
    value: `${grouped(now, 1)}%`,
    delta: year === null ? null : `${ppLabel(now - year)} on ${monthYear(ramp.months[n - 13]!)}`,
    lines: [
      `${monthYear(ramp.months[n - 1]!)}, from Ramp’s release first stored ${ramp.release_seen}.${
        overall === null ? '' : ` Any AI vendor: ${grouped(overall, 1)}%.`
      }`,
    ],
    gap: null,
    ref: cite(ramp.source, ramp.source.label),
  }
}

function agentFigures(
  lab: LabId,
  rows: AdoptionData['agent_prs'] | undefined,
  cite: Cite,
): SheetFigure[] {
  return (rows ?? [])
    .filter((a) => a.lab === lab)
    .map((a) => {
      const label = `Public PRs by ${a.agent}, a week`
      const week = a.weekly.at(-1)
      if (!week) return gapFigure(label, 'No complete week on record')
      // Only two whole weeks compare: a week with days missing undercounts.
      const before = a.weekly.at(-2) ?? null
      const ch =
        before && !before.partial && !week.partial ? pctChange(before.total, week.total) : null
      return {
        label,
        value: count(week.total),
        delta: ch === null ? null : `${pctLabel(ch)} on the week before`,
        lines: [
          `Week of ${week.week}${week.partial ? `, ${week.days} of 7 days on record` : ''}.${
            week.retrospective ? ' Counted later, from the pull requests that still existed.' : ''
          }`,
        ],
        gap: null,
        ref: a.source ? cite(a.source, a.source.label) : null,
      }
    })
}

function powerFigure(
  lab: LabId,
  display: string,
  data: RecipeInputs['datacenters'],
  cite: Cite,
): SheetFigure {
  const label = 'Data-center power'
  if (!data) return gapFigure(label, 'No power data yet')
  const row = data.labs.find((l) => l.lab === lab)
  if (!row) {
    return data.speculative_only.includes(lab)
      ? gapFigure(
          label,
          'No site counted',
          'Epoch names this lab as a user only at #speculative, which we don’t count.',
        )
      : gapFigure(
          label,
          'No site named',
          `Epoch AI’s data names no data center with ${display} as a user.`,
        )
  }
  const shared = row.shared ? `, ${count(row.shared)} shared with another lab` : ''
  const largest = row.names.slice(0, 3).join(', ')
  const asOf = data.snapshot ? ` Epoch’s data of ${data.snapshot}.` : ''
  const ref = data.source ? cite(data.source, data.source.label) : null
  if (row.mw === 0) {
    return {
      ...gapFigure(
        label,
        'No power yet',
        `Epoch puts current power at 0 MW for ${display}’s ${row.sites === 1 ? 'site' : 'sites'}. Its data counts power already online, so a site still being built reads as zero.`,
      ),
      lines: [`${sites(row.sites)}: ${largest}.${asOf}`],
      ref,
    }
  }
  return {
    label,
    value: `${count(Math.round(row.mw))} MW`,
    delta: null,
    lines: [
      `${compactCount(row.h100e)} H100-equivalents across ${sites(row.sites)}${shared}.`,
      `Largest: ${largest}.${asOf}`,
    ],
    gap: null,
    ref,
  }
}

/** The recipe sections for one lab, citing into the sheet's one source list. */
export function buildRecipeSections(
  lab: LabId,
  display: string,
  input: RecipeInputs,
  cite: Cite,
): SheetRecipes {
  const caveats: SheetCaveat[] = []
  const citations: string[] = []
  const ad = input.adoption ?? null

  const ramp = rampFigure(lab, display, ad?.ramp ?? undefined, cite)
  const agents = agentFigures(lab, ad?.agent_prs, cite)
  if (ad && ramp.value !== null) caveats.push({ label: 'Ramp adoption', text: ad.caveats.ramp })

  const downloads: SheetDownload[] = (ad?.downloads ?? [])
    .filter((d) => d.lab === lab)
    .sort((a, b) => (b.last_28d ?? -1) - (a.last_28d ?? -1))
    .map((d) => {
      const ch = pctChange(d.prior_28d, d.last_28d)
      return {
        key: d.recipe_id,
        package: d.package,
        registry: d.registry,
        kind: d.kind === 'agent' ? 'Agent' : 'SDK',
        last: d.last_28d === null ? null : compactCount(d.last_28d),
        change: ch === null ? '—' : pctLabel(ch),
        through: d.through ?? '',
        ref: d.source ? cite(d.source, `${d.registry} ${d.package}`) : null,
      }
    })
  if (ad && downloads.length) {
    caveats.push({ label: 'Package downloads', text: ad.caveats.downloads })
  }
  if (ad && agents.some((a) => a.value !== null)) {
    caveats.push({ label: 'Coding-agent PRs', text: ad.caveats.agent_prs })
  }

  const boards = (input.pay?.boards ?? []).filter((b) => b.lab === lab)
  const pay: SheetPay[] = boards.flatMap((b) => {
    const ref = cite(b.source, b.source.label)
    return b.cells.map((c) => {
      const ch = c.previous ? pctChange(c.previous.median, c.median) : null
      return {
        key: `${b.recipe_id}|${c.key}`,
        label: c.label,
        median: compactUsd(c.median),
        range: `${compactUsd(c.p25)}–${compactUsd(c.p75)}`,
        bands: `${count(c.n)}${c.key === 'all' ? ` of ${count(b.roles_on_board)}` : ''}`,
        change: ch === null ? `First read ${b.date}` : `${pctLabel(ch)} since ${c.previous!.date}`,
        ref,
      }
    })
  })
  if (input.pay && pay.length) caveats.push({ label: 'Posted pay', text: input.pay.caveat })

  const power = powerFigure(lab, display, input.datacenters, cite)
  if (input.datacenters && power.ref !== null) {
    caveats.push({ label: 'Data-center power', text: input.datacenters.caveat })
    citations.push(EPOCH_LICENSE)
  }

  const limits: SheetLimitPage[] = (input.limits?.pages ?? [])
    .filter((p) => p.lab === lab)
    .map((p) => ({
      key: p.recipe_id,
      covers: p.covers,
      limits: count(p.rows.reduce((n, r) => n + Object.keys(r.values).length, 0)),
      change: p.previous
        ? `${count(p.changed)} changed on ${p.snapshot}`
        : `None since first read, ${p.snapshot}`,
      ref: cite(p.source, p.source.label),
    }))
  if (input.limits && limits.length) {
    caveats.push({ label: 'Rate limits', text: input.limits.caveat })
  }

  return {
    adoption: [ramp, ...agents],
    downloads: {
      rows: downloads,
      gap: downloads.length
        ? null
        : {
            title: 'No package tracked',
            reason: `We count no npm or PyPI package of ${display}’s.`,
          },
    },
    pay: {
      rows: pay,
      gap: pay.length
        ? null
        : { title: 'No posted pay read', reason: `We read no posted salary bands for ${display}.` },
    },
    power,
    limits: {
      rows: limits,
      gap: limits.length
        ? null
        : {
            title: 'No published limits read',
            reason: `We read no per-model rate-limit page for ${display}.`,
          },
    },
    caveats,
    citations,
  }
}
