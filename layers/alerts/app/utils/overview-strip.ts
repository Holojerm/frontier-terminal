// What the front page keeps of /api/overview before Nuxt serializes it: five alert rows,
// each lab's newest alert and the newest minor change. The API returns every alert with its
// cited rows (about 110 kB of the page's 210 kB payload).

/** Rows on the signal band (SignalBand.vue SHOWN). */
export const OVERVIEW_BAND_ROWS = 5

// The explanation, cited ids and row text are on the permalink; the page reads only lab,
// axis and the one figure that moved (alertLabs, alertAxis, alertDelta in terminal-labs.ts).
//
// Most rows an alert cites slim to the same thing (a hiring batch is 150 "anthropic job
// added"), so equal ones share one object, which the payload serializer writes once. That
// took /alerts' payload from 550 kB to 150 kB.
export function slimAlerts(alerts: AlertView[]): AlertView[] {
  const seen = new Map<string, ChangeView>()
  const slim = (c: ChangeView): ChangeView => {
    const diff = c.diff.filter((d) => d.field === 'input_per_mtok' || d.field === 'output_per_mtok')
    const key = JSON.stringify([c.entity_type, c.provider, c.change_type, diff])
    let kept = seen.get(key)
    if (!kept) {
      kept = {
        id: '',
        entity_key: '',
        entity_type: c.entity_type,
        provider: c.provider,
        change_type: c.change_type,
        detected_at: '',
        source_url: '',
        fetched_at: '',
        summary: '',
        diff,
      }
      seen.set(key, kept)
    }
    return kept
  }
  return alerts.map((a) => ({
    ...a,
    explanation: '',
    change_ids: [],
    missing_change_ids: [],
    changes: a.changes.map(slim),
  }))
}

export function overviewStrip(data: OverviewData): OverviewData {
  const band = data.alerts.slice(0, OVERVIEW_BAND_ROWS)
  const perLab = data.lab_alerts
  // Slimmed in one pass, so a row on the band and in the readout shares its cited rows.
  const slim = slimAlerts([...band, ...perLab, ...data.info.slice(0, 1)])
  return {
    ...data,
    alerts: slim.slice(0, band.length),
    lab_alerts: slim.slice(band.length, band.length + perLab.length),
    info: slim.slice(band.length + perLab.length),
  }
}
