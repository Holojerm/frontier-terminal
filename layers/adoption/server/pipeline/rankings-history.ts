import {
  contentHashOfText,
  SnapshotRow,
  StoredEntityRow,
} from '../../../core/server/utils/contracts'
import { normalizeRankings } from './normalize'
import { parseOpenRouterRankings } from './parsers/openrouter-rankings'

// OpenRouter's rankings from before the live source began reading them
// (scripts/rankings-backfill.ts). The live fetch takes the endpoint's default
// trailing 30 days, so the stored series starts 2026-08-10. The dataset itself
// goes back to 2025-01-01 and takes start_date/end_date at most 366 days apart
// (openrouter.ai/docs/cookbook/administration/data-api, read 2026-11-20). It
// is the same dataset under the same license, so its rows go into the live
// source's entities as they are, each citing the windowed URL it came from.

export const RANKINGS_SOURCE_ID = 'openrouter-rankings-daily'
export const RANKINGS_URL = 'https://openrouter.ai/api/v1/datasets/rankings-daily'
/** The dataset's first day. */
const RANKINGS_FROM = '2025-01-01'
/** end_date minus start_date may be at most 366 days; 365 keeps clear of the edge. */
const MAX_SPAN_DAYS = 365

const DAY_MS = 86_400_000
const shift = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

export interface Window {
  start: string
  end: string
}

/**
 * The windows that reach from the dataset's first day to the day before the
 * oldest stored one, newest first: an interrupted run has moved the oldest
 * day back, so the next run asks only for what is still missing.
 */
export function backfillWindows(oldestStored: string, from = RANKINGS_FROM): Window[] {
  const out: Window[] = []
  let end = shift(oldestStored, -1)
  while (end >= from) {
    const start = shift(end, -MAX_SPAN_DAYS) < from ? from : shift(end, -MAX_SPAN_DAYS)
    out.push({ start, end })
    end = shift(start, -1)
  }
  return out
}

export function windowUrl({ start, end }: Window): string {
  return `${RANKINGS_URL}?start_date=${start}&end_date=${end}`
}

interface WindowRows {
  snapshot: SnapshotRow
  entities: StoredEntityRow[]
  as_of: string | undefined
}

/**
 * One window's answer as a snapshot and its entities, the shapes the live
 * lane writes (refresh.ts, lanes.ts). Throws when OpenRouter answered for
 * other dates than asked (a clamped start, a later end), since rows outside
 * the window could overlap the live series.
 */
export function windowRows(window: Window, text: string, fetched_at: string): WindowRows {
  const source_url = windowUrl(window)
  const meta = (JSON.parse(text) as { meta?: { start_date?: unknown; end_date?: unknown } }).meta
  if (meta?.start_date !== window.start || meta?.end_date !== window.end) {
    throw new Error(
      `asked for ${window.start}..${window.end}, OpenRouter answered ${String(meta?.start_date)}..${String(meta?.end_date)}`,
    )
  }
  const { rows, as_of } = parseOpenRouterRankings(text, { source_url, fetched_at })
  const stray = rows.find((r) => r.date < window.start || r.date > window.end)
  if (stray) throw new Error(`row dated ${stray.date} outside ${window.start}..${window.end}`)

  const snapshot = SnapshotRow.parse({
    id: `${RANKINGS_SOURCE_ID}:${fetched_at}`,
    source_id: RANKINGS_SOURCE_ID,
    content_hash: contentHashOfText(text),
    raw_key: `raw/${RANKINGS_SOURCE_ID}/${fetched_at}.json`,
    http_status: 200,
    bytes: new TextEncoder().encode(text).byteLength,
    source_url,
    fetched_at,
  })
  const entities = normalizeRankings(rows, snapshot.id).map((row) =>
    StoredEntityRow.parse({ ...row, source_id: RANKINGS_SOURCE_ID, first_seen_at: fetched_at }),
  )
  return { snapshot, entities, as_of }
}
