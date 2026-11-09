// What the front page keeps of /api/overview before Nuxt serialises it into the
// hydration payload. The page draws five alert rows, the newest minor change, and
// each lab's newest alert in the readout; the API returns every alert with its
// cited rows (about 110 kB of the page's 210 kB payload). Everything else is on
// /alerts, one link away.

import { alertLabs } from '../../shared/utils/terminal-labs'
import type { AlertView, ChangeView, OverviewData } from '../../shared/utils/terminal-types'

/** Rows on the signal band (SignalBand.vue SHOWN). */
export const OVERVIEW_BAND_ROWS = 5

// The explanation, the cited ids and each row's text are on the permalink; no row on
// the page prints them. What it reads off `changes` is lab, axis and the one figure
// that moved (alertLabs, alertAxis, alertDelta in terminal-labs.ts).
export function slimAlert(a: AlertView): AlertView {
  return {
    ...a,
    explanation: '',
    change_ids: [],
    missing_change_ids: [],
    changes: a.changes.map((c): ChangeView => ({
      id: '',
      entity_key: '',
      entity_type: c.entity_type,
      provider: c.provider,
      change_type: c.change_type,
      detected_at: '',
      source_url: '',
      fetched_at: '',
      summary: '',
      diff: c.diff.filter((d) => d.field === 'input_per_mtok' || d.field === 'output_per_mtok'),
    })),
  }
}

export function overviewStrip(data: OverviewData, labs: readonly string[]): OverviewData {
  // Newest first across both tiers, the order the readout reads them in.
  const merged = [...data.alerts, ...data.info].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  )
  const keep = new Set<string>(data.alerts.slice(0, OVERVIEW_BAND_ROWS).map((a) => a.id))
  if (data.info[0]) keep.add(data.info[0].id)
  for (const lab of labs) {
    const newest = merged.find((a) => alertLabs(a).includes(lab as never))
    if (newest) keep.add(newest.id)
  }
  return {
    ...data,
    alerts: data.alerts.filter((a) => keep.has(a.id)).map(slimAlert),
    info: data.info.filter((a) => keep.has(a.id)).map(slimAlert),
  }
}
