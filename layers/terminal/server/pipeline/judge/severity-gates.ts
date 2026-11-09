import type { ChangeRow } from '../contracts'
import type { FloorClamp } from '../hiring-floor'
import { isRoutine8K, rootForm } from '../parsers/sec/forms'

// Worker-side severity rules for the judge's filing and pricing alerts, the
// counterpart of the hiring floor (hiring-floor.ts). The prompt states the same
// rules, but only these bind. Each only lowers a severity, and only when every
// change an alert cites is one the rule covers: a price cut cited beside a
// launch is carried by the launch.
//
// A model removal that another page of the lab still lists
// (still-listed.ts) is a page dropping a row, not a delisting: an alert that
// cites only such removals is a ticker line, whatever model it names.

interface PriceFields {
  provider?: string
  model_slug?: string
  tier?: string | null
  input_per_mtok?: number | null
  output_per_mtok?: number | null
}

const parsed = <T>(json: string | null): T | null => (json ? (JSON.parse(json) as T) : null)

function routine8K(change: ChangeRow): boolean {
  if (change.entity_type !== 'filing') return false
  const row = parsed<{ form?: string; items?: string[] }>(change.after_json ?? change.before_json)
  return row?.form !== undefined && rootForm(row.form) === '8-K' && isRoutine8K(row.items ?? [])
}

/**
 * A price move no reader of the matrix would act on: a discount or premium
 * tier, a cached-input-only change, or a delisting, on a model the matrix does
 * not track. A new SKU and a list-price change are never minor.
 */
function minorPriceChange(change: ChangeRow, tracked: ReadonlySet<string>): boolean {
  if (change.entity_type !== 'model' || change.change_type === 'added') return false
  const before = parsed<PriceFields>(change.before_json)
  const after = parsed<PriceFields>(change.after_json)
  const row = after ?? before
  if (!row || tracked.has(`${change.provider}:${row.model_slug}`)) return false
  const listPrice = row.tier === null || row.tier === undefined || row.tier === 'standard'
  if (change.change_type === 'removed' || !listPrice) return true
  return (
    before?.input_per_mtok === after?.input_per_mtok &&
    before?.output_per_mtok === after?.output_per_mtok
  )
}

/** Lower every alert-tier alert the rules above cover to `info`. */
export function clampRoutineAlerts<
  A extends { severity: 'info' | 'notable' | 'critical'; headline: string; change_ids: string[] },
>(
  alerts: readonly A[],
  supplied: readonly ChangeRow[],
  tracked: ReadonlySet<string>,
  /** Ids of model removals another page of the lab still lists. */
  stillListed: ReadonlySet<string> = new Set(),
): { alerts: A[]; clamped: FloorClamp[] } {
  const byId = new Map(supplied.map((c) => [c.id, c]))
  const out: A[] = []
  const clamped: FloorClamp[] = []
  for (const alert of alerts) {
    const cited = alert.change_ids.flatMap((id) => byId.get(id) ?? [])
    const detail =
      cited.length === 0
        ? null
        : cited.every(routine8K)
          ? 'an 8-K with routine items only'
          : cited.every((c) => stillListed.has(c.id))
            ? 'a model dropped from one page that another page of the lab still lists'
            : cited.every((c) => minorPriceChange(c, tracked))
              ? 'a minor price change on a model the matrix does not track'
              : null
    if (alert.severity === 'info' || detail === null) {
      out.push(alert)
      continue
    }
    clamped.push({ headline: alert.headline, from: alert.severity, to: 'info', detail })
    out.push({ ...alert, severity: 'info' })
  }
  return { alerts: out, clamped }
}
