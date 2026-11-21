// What moved between consecutive archived copies of a lab's rate-limit page
// (archived_rate_limits): a limit both copies print, at a different value.
// Pure, like price-events.ts: the read side lists the changes, and the
// harness takes the raises as events, each dated by a release note that
// talks about limits inside the window between the copies, or at the copy
// before with the window as its uncertainty.

import type { ReleaseNote } from './release-notes'

export interface LimitCapture {
  id: string
  provider: string
  captured_at: string
  source_url: string
}

export interface LimitRowIn {
  capture_id: string
  recipe_id: string
  key: string
  model: string
  tier: string
  metric: string
  value: number | null
}

export interface LimitChange {
  recipe_id: string
  provider: string
  key: string
  model: string
  tier: string
  metric: string
  before: number
  after: number
  window_from: string
  window_to: string
  window_days: number
  /** YYYY-MM-DD: the release note's date, or the day of the copy before. */
  date: string
  dated_by: 'release_note' | 'window'
  date_source_url: string | null
  /** The copy that first shows the new value. */
  source_url: string
}

const DAY_MS = 86_400_000
const day = (iso: string) => iso.slice(0, 10)

/** Every change, oldest first. A limit printed as none (null) on either side is no change we can size. */
export function limitChanges(
  captures: readonly LimitCapture[],
  rows: readonly LimitRowIn[],
  notes: readonly ReleaseNote[],
): LimitChange[] {
  const byId = new Map(captures.map((c) => [c.id, c]))
  const series = new Map<string, { capture: LimitCapture; row: LimitRowIn }[]>()
  for (const r of rows) {
    const c = byId.get(r.capture_id)
    if (!c) continue
    const k = `${r.recipe_id}|${r.key}`
    series.set(k, [...(series.get(k) ?? []), { capture: c, row: r }])
  }
  const out: LimitChange[] = []
  for (const list of series.values()) {
    list.sort((a, b) => (a.capture.captured_at < b.capture.captured_at ? -1 : 1))
    for (let i = 1; i < list.length; i++) {
      const [prev, cur] = [list[i - 1]!, list[i]!]
      const [before, after] = [prev.row.value, cur.row.value]
      if (before === null || after === null || before === after) continue
      const from = prev.capture.captured_at
      const to = cur.capture.captured_at
      const lo = new Date(Date.parse(`${day(from)}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10)
      const note = notes
        .filter(
          (n) =>
            n.provider === cur.capture.provider && n.limits && n.date >= lo && n.date <= day(to),
        )
        .sort((a, b) => (a.date < b.date ? -1 : 1))[0]
      out.push({
        recipe_id: cur.row.recipe_id,
        provider: cur.capture.provider,
        key: cur.row.key,
        model: cur.row.model,
        tier: cur.row.tier,
        metric: cur.row.metric,
        before,
        after,
        window_from: from,
        window_to: to,
        window_days: note
          ? 0
          : Math.round(
              (Date.parse(`${day(to)}T00:00:00Z`) - Date.parse(`${day(from)}T00:00:00Z`)) / DAY_MS,
            ),
        date: note ? note.date : day(from),
        dated_by: note ? 'release_note' : 'window',
        date_source_url: note?.url ?? null,
        source_url: cur.capture.source_url,
      })
    }
  }
  return out.sort((a, b) =>
    a.window_from < b.window_from
      ? -1
      : a.window_from > b.window_from
        ? 1
        : a.key.localeCompare(b.key),
  )
}
