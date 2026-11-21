// Launches and price changes read off the archived price lists
// (archived_prices), for the event studies on the labs' tickers. Pure: the
// parsed captures and their rows in, events out. Nothing is stored; the
// signal loader derives them each run (signals/sources.ts), so a re-parse or
// a narrower capture window reaches the harness without a migration.
//
// A launch is a model's first appearance on its lab's list; a price change is
// a SKU's input price moving between two consecutive copies that both list
// it. Either is known only to fall between the copy before and the copy that
// shows it, so each event carries that window. Where the lab's own release
// notes (release-notes.ts) date a note naming the model inside the window,
// the event takes the note's date and URL; otherwise it is dated at the
// window's start and keeps the window's width as its uncertainty, which the
// harness uses to leave it out of the short horizons (harness.ts ›
// maxWindowDays).
//
// Never counted twice: every era ends by ARCHIVE_UNTIL, and the live loaders
// start there. Never guessed: a model or price seen first on a copy read by a
// different parser than the copy before (an era boundary) is an event only
// when a release note dates it inside the window, since a new page layout
// can list models the old parser never read.

import { canonicalModel, type ReleaseNote } from './release-notes'

export interface EventCapture {
  id: string
  era: string
  provider: string
  captured_at: string
  source_url: string
}

export interface EventPriceRow {
  capture_id: string
  entity_key: string
  payload: string
}

export type PriceEventKind = 'launch' | 'price_cut' | 'price_raise'

export interface ArchivedPriceEvent {
  kind: PriceEventKind
  provider: string
  /** The model as the list named it (its slug, without a tier). */
  model: string
  /** Price changes: the SKU (model:<provider>:<slug>[:<tier>]). */
  entity_key: string | null
  /** Price changes: the input $/MTok on the copy before and the copy after. */
  before: number | null
  after: number | null
  /** The copy before (which didn't list it, or listed the old price) and the first copy that shows it. */
  window_from: string
  window_to: string
  /** Whole days between the two copies: the date's uncertainty, 0 once a release note dates it. */
  window_days: number
  /** YYYY-MM-DD: the release note's date, or the day of the copy before. */
  date: string
  dated_by: 'release_note' | 'window'
  /** The release note's page, when one dates it. */
  date_source_url: string | null
  date_title: string | null
  /** The copy that first shows it. */
  source_url: string
}

interface SkippedEvent {
  kind: PriceEventKind
  provider: string
  model: string
  window_from: string
  window_to: string
  reason: string
}

const DAY_MS = 86_400_000
const day = (iso: string) => iso.slice(0, 10)
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

/** A model's slug and tier from its entity_key (model:<provider>:<slug>[:<tier>]). */
export function slugOf(entityKey: string): string {
  return entityKey.split(':')[2] ?? entityKey
}

function inputPrice(payload: string): number | null {
  try {
    const v = (JSON.parse(payload) as { input_per_mtok?: unknown }).input_per_mtok
    return typeof v === 'number' && v > 0 ? v : null
  } catch {
    return null
  }
}

/** Two prices read from different units (per 1K, per 1M) can differ in the last bits. */
const samePrice = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(a, b)

/** A lab can announce a price change before its page shows it: a price note this far before the copy before still dates it. */
const PRICE_NOTE_LEAD_DAYS = 14

/**
 * The release note that dates an event: on or after the day before the copy
 * before (the copy's UTC time can be the evening before in the lab's zone),
 * or PRICE_NOTE_LEAD_DAYS before it for a price change, on or before the day
 * of the copy that shows it, naming the model, and talking about price when
 * the event is a price change. The earliest wins.
 */
function datingNote(
  notes: readonly ReleaseNote[],
  provider: string,
  model: string,
  from: string,
  to: string,
  price: boolean,
): ReleaseNote | null {
  const name = canonicalModel(model)
  const lo = addDays(day(from), price ? -PRICE_NOTE_LEAD_DAYS : -1)
  const hi = day(to)
  let best: ReleaseNote | null = null
  for (const n of notes) {
    if (n.provider !== provider || n.date < lo || n.date > hi) continue
    if (!n.names.includes(name) || (price && !n.price)) continue
    if (!best || n.date < best.date) best = n
  }
  return best
}

interface DerivedEvents {
  events: ArchivedPriceEvent[]
  skipped: SkippedEvent[]
}

/** A price that moves and moves back within this many days is a misread copy, not two changes. */
const FLICKER_DAYS = 30

/** Copies at most this far apart bound a release closely enough for a note inside them to date it. */
const NARROW_WINDOW_DAYS = 31

interface RawChange {
  model: string
  key: string
  before: number
  after: number
  prev: EventCapture
  cur: EventCapture
}

/** Drop each change the next change of the same SKU undoes within FLICKER_DAYS. */
function withoutFlickers(changes: readonly RawChange[], skipped: SkippedEvent[]): RawChange[] {
  const byKey = new Map<string, RawChange[]>()
  for (const c of changes) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c])
  const dropped = new Set<RawChange>()
  for (const list of byKey.values()) {
    for (let i = 0; i + 1 < list.length; i++) {
      const [a, b] = [list[i]!, list[i + 1]!]
      const days = (Date.parse(b.cur.captured_at) - Date.parse(a.cur.captured_at)) / DAY_MS
      if (samePrice(a.before, b.after) && days <= FLICKER_DAYS) {
        for (const c of [a, b]) {
          dropped.add(c)
          skipped.push({
            kind: c.after < c.before ? 'price_cut' : 'price_raise',
            provider: c.cur.provider,
            model: c.model,
            window_from: c.prev.captured_at,
            window_to: c.cur.captured_at,
            reason: `${c.key} went ${a.before} → ${a.after} → ${b.after} within ${Math.round(days)} days: a misread copy`,
          })
        }
        i++
      }
    }
  }
  return changes.filter((c) => !dropped.has(c))
}

/**
 * Every launch and input-price change the archived lists show, oldest first.
 * `captures` are the parsed copies; `rows` their archived_prices rows;
 * `coverage` the first day each lab's release notes date, from which an
 * event needs a note to count.
 */
export function derivePriceEvents(
  captures: readonly EventCapture[],
  rows: readonly EventPriceRow[],
  notes: readonly ReleaseNote[],
  coverage: Readonly<Record<string, string>>,
): DerivedEvents {
  const byCapture = new Map<string, EventPriceRow[]>()
  for (const r of rows) byCapture.set(r.capture_id, [...(byCapture.get(r.capture_id) ?? []), r])
  const providers = new Map<string, EventCapture[]>()
  for (const c of captures) {
    if (!byCapture.has(c.id)) continue
    providers.set(c.provider, [...(providers.get(c.provider) ?? []), c])
  }

  const events: ArchivedPriceEvent[] = []
  const skipped: SkippedEvent[] = []
  for (const [provider, list] of providers) {
    list.sort((a, b) =>
      a.captured_at < b.captured_at ? -1 : a.captured_at > b.captured_at ? 1 : 0,
    )
    const seen = new Set<string>()
    /** The newest copy that listed each SKU, with its price there. */
    const last = new Map<string, { capture: EventCapture; price: number | null }>()

    const covered = coverage[provider]
    const emit = (
      kind: PriceEventKind,
      model: string,
      prev: EventCapture,
      cur: EventCapture,
      price?: { key: string; before: number; after: number },
    ) => {
      const skip = (reason: string): void => {
        skipped.push({
          kind,
          provider,
          model,
          window_from: prev.captured_at,
          window_to: cur.captured_at,
          reason,
        })
      }
      const width = Math.round(
        (Date.parse(`${day(cur.captured_at)}T00:00:00Z`) -
          Date.parse(`${day(prev.captured_at)}T00:00:00Z`)) /
          DAY_MS,
      )
      const name = canonicalModel(model)
      const note = datingNote(notes, provider, model, prev.captured_at, cur.captured_at, !!price)
      // A note before the copy before already named the model. Across a
      // narrow window a note inside it still dates a release (a preview, then
      // general availability); across a wide one the model was listed late.
      const earlier =
        kind === 'launch' && (!note || width > NARROW_WINDOW_DAYS)
          ? notes.find(
              (n) =>
                n.provider === provider &&
                n.date < addDays(day(prev.captured_at), -1) &&
                n.names.includes(name),
            )
          : undefined
      if (earlier) {
        return skip(
          `named in a release note of ${earlier.date}, before the copy before: listed late`,
        )
      }
      // A new name on a list is often a listing, not a release, so where the
      // lab's notes date its releases a launch needs one. A price both copies
      // print, read by one parser, moved: it keeps its window.
      if (kind === 'launch' && !note && covered !== undefined && day(prev.captured_at) >= covered) {
        return skip('no release note names it between the two copies')
      }
      if (!note && prev.era !== cur.era) {
        return skip(
          `first seen on a ${cur.era} copy after a ${prev.era} copy, and no release note dates it`,
        )
      }
      events.push({
        kind,
        provider,
        model,
        entity_key: price?.key ?? null,
        before: price?.before ?? null,
        after: price?.after ?? null,
        window_from: prev.captured_at,
        window_to: cur.captured_at,
        window_days: note ? 0 : width,
        date: note ? note.date : day(prev.captured_at),
        dated_by: note ? 'release_note' : 'window',
        date_source_url: note?.url ?? null,
        date_title: note?.title ?? null,
        source_url: cur.source_url,
      })
    }

    const changes: RawChange[] = []
    list.forEach((cur, i) => {
      const prev = list[i - 1]
      const listed = byCapture.get(cur.id)!
      const models = new Set(listed.map((r) => slugOf(r.entity_key)))
      for (const model of [...models].sort()) {
        const name = canonicalModel(model)
        if (seen.has(name)) continue
        seen.add(name)
        // The first copy of a lab's list is where we start, not a launch.
        if (prev) emit('launch', model, prev, cur)
      }
      for (const r of listed) {
        const price = inputPrice(r.payload)
        const before = last.get(r.entity_key)
        last.set(r.entity_key, { capture: cur, price })
        if (!before || before.price === null || price === null) continue
        if (samePrice(before.price, price)) continue
        changes.push({
          model: slugOf(r.entity_key),
          key: r.entity_key,
          before: before.price,
          after: price,
          prev: before.capture,
          cur,
        })
      }
    })
    for (const c of withoutFlickers(changes, skipped)) {
      emit(c.after < c.before ? 'price_cut' : 'price_raise', c.model, c.prev, c.cur, c)
    }
  }
  const order = (a: { date?: string; window_from: string }, b: typeof a) =>
    a.window_from < b.window_from ? -1 : a.window_from > b.window_from ? 1 : 0
  return { events: events.sort(order), skipped: skipped.sort(order) }
}
