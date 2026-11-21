import {
  contentHash,
  type AlertRow,
  type ChangeRow,
  type EntityRow,
  type Provenance,
} from '../utils/contracts'
import type { PipelineDb } from '../utils/pipeline-store'
import type { LaneBlocks, TickInputs } from '#server/registries/lane-context'

// The lane contract: how each include source turns a fetched body into
// entities — the join between the registry (which runs parsers on committed
// fixtures with fixture provenance) and a live tick (which stamps the fetch's
// own provenance and joins against payloads fetched in the same tick). Each
// domain defines its lanes beside its parsers; server/registries/lanes.ts
// assembles them, and server/registries/lane-context.ts types what a parse
// reads beyond its own fetch.
//
// A source with no lane is fetched and snapshotted but yields no entities:
// the Greenhouse /departments feeds exist to be joined, and the OpenRouter
// model list is a cross-check that must never become a source of record
// (sources.yaml).

export interface ParseContext extends LaneBlocks, Partial<TickInputs> {
  prov: Provenance
  snapshotId: string
  /** Body of a side source fetched in this same tick; throws if it was not. */
  side: (sourceId: string) => string
  /** For a derived source, the key it was derived for (a CIK or a slug); null for a registered one. */
  derivedKey: string | null
}

export interface ParseResult {
  entities: EntityRow[]
  /** Anything the parser saw and deliberately did not turn into rows. */
  note?: string
  /**
   * Parts of the page the parser could not read, while the rest stored. Each
   * is spooled, and the page is read again next tick (refresh.ts › INCOMPLETE).
   */
  problems?: string[]
}

/** An ops event a lane's stored changes raise: something the owner has to redo by hand. */
export interface LaneOpsEvent {
  kind: string
  /** Prefixed with the source id when it is spooled. */
  detail: string
}

export interface Lane {
  /** Source ids that must be fetched in the same tick for parse() to run. */
  sides: readonly string[]
  /**
   * 'set': the page IS the current set, so an entity that disappears is a
   * removal (a job closed, a model delisted). 'append-only': the feed is a
   * recent-filings window, and a filing scrolling out of it was not un-filed —
   * no removal is recorded and the entity stays.
   */
  removals: 'set' | 'append-only'
  /**
   * A source's first parse is normally a quiet baseline: what was there
   * before we watched is not news. True when this source's first parse IS
   * the event — a registration document is its own source, so its first and
   * only content is the filing itself. Called with the derived key and the
   * fetch time.
   */
  firstIsNews?: (derivedKey: string | null, fetchedAt: string) => boolean
  /**
   * The sources.yaml-derived blocks parse() reads. They go into the context
   * fingerprint (contextFingerprint), so an unchanged page is parsed again
   * when one of them changes — a filer retagged, a CIK whitelisted.
   */
  reads?: readonly ContextBlock[]
  parse(text: string, ctx: ParseContext): ParseResult
  alerts?: (changes: readonly ChangeRow[]) => AlertRow[]
  /** Ops events the stored 'modified' changes raise, spooled once the diff is written. */
  opsEvents?: (modified: readonly ChangeRow[]) => LaneOpsEvent[]
}

export type ContextBlock = keyof LaneBlocks

/**
 * A value every parse in a tick may read, loaded once before the first
 * source: a domain's entry in server/registries/lane-context.ts › TICK_INPUTS.
 */
export interface TickInput<T> {
  load: (db: PipelineDb) => Promise<T>
  /** The key the cited part is hashed under in a parse's input (refresh.ts › ParseBasis). */
  basisKey: string
  /**
   * The part of the value the parse of `sourceIds` (a source and its sides)
   * reads. It is hashed into that parse's input, so a change to it is news,
   * as a changed page is.
   */
  cited: (value: T, sourceIds: readonly string[]) => unknown
}

/**
 * Bump when a parser change makes the same bytes yield different rows. Every
 * lane's next tick then parses its unchanged page again and rewrites the
 * stored rows in place without logging a change: a parser learning to read a
 * field is not the vendor changing it.
 */
export const PARSER_VERSION = 1

/** Hashable form of a context block: stableStringify reads a Map or Set as
 * `{}`, so those become their entries, sorted so insertion order is moot. */
function canonical(block: ParseContext[ContextBlock]): unknown {
  if (!(block instanceof Map) && !(block instanceof Set)) return block
  const entries: unknown[] = block instanceof Map ? [...block.entries()] : [...block]
  return entries.sort((a, b) => {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)]
    return x < y ? -1 : x > y ? 1 : 0
  })
}

/** The parser version, every config block the lane reads, and the URL its rows cite, hashed. */
export function contextFingerprint(
  lane: Lane,
  ctx: Pick<ParseContext, ContextBlock>,
  sourceUrl: string,
): string {
  const blocks: Record<string, unknown> = {}
  for (const name of lane.reads ?? []) blocks[name] = canonical(ctx[name])
  return contentHash({ parser_version: PARSER_VERSION, source_url: sourceUrl, ...blocks })
}

/**
 * A parse failure the next tick is expected to clear, thrown by a parser that
 * knows its own blip (a Greenhouse board and its /departments feed fetched a
 * second apart). The refresh records the run either way but raises the ops
 * event only when the next tick has not cleared it.
 */
export class TransientParseError extends Error {}

/**
 * Fields a source returns that name people, removed before a payload is
 * hashed, archived to R2 or parsed: a domain's entry in
 * server/registries/lanes.ts › PAYLOAD_REDACTIONS. The content hash and the
 * archived object are of the redacted text, so the archive never holds the
 * removed fields.
 */
export interface PayloadRedaction {
  /** True for the fetched URLs this redaction applies to. */
  matches: (url: string) => boolean
  /** The payload as it may be stored. May throw on a body it cannot read. */
  redact: (text: string) => string
}

/** The payload as it may be stored. A body a redaction cannot read is left for the parser to reject. */
export function redactPayload(
  redactions: readonly PayloadRedaction[],
  url: string,
  text: string,
): string {
  let out = text
  for (const r of redactions) {
    if (!r.matches(url)) continue
    try {
      out = r.redact(out)
    } catch {
      // Unparseable: stored as fetched, and the parser rejects it.
    }
  }
  return out
}

/** A lane whose page is the current set and joins no side. */
export const setLane = (parse: Lane['parse']): Lane => ({ sides: [], removals: 'set', parse })

/**
 * Alerts a domain raises from one source's changes by reading the store, after
 * the lane's own: server/registries/lanes.ts › CHANGE_ALERTS, run in order.
 */
export type ChangeAlertRule = (
  db: PipelineDb,
  sourceId: string,
  changes: readonly ChangeRow[],
) => Promise<AlertRow[]>
