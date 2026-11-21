import type { JudgeAlert } from './alerts'

// Grounding check for the judge lane, run after the schema gate: the model may
// cite only what is in the change records it was given. An alert survives only if
//   1. every change_id names a supplied change row;
//   2. every number in headline+explanation appears in the cited rows'
//      before_json/after_json/entity_key ("$7.50" grounds 7.5; a derived "-33%"
//      does not), or is the dotted version of a cited slug ("Opus 5.5" from
//      claude-opus-5-5). A time of day grounds only a time of day (splitClocks);
//   3. every slug-like token with a digit ("grok-4.6") and every "double-quoted
//      span" appears verbatim, case-insensitively (spanIsGrounded).
// A rejected alert is dropped, never repaired. It is a coarse tripwire against
// invention, not a re-judging. Slugs need a digit because "near-term" and
// "input/output" otherwise rejected every live output measured.

export type AlertGroundingReason =
  | 'unknown-change-id'
  | 'unoffered-change-id'
  | 'ungrounded-number'
  | 'ungrounded-term'
  // A still-listed model called delisted (still-listed.ts); runs after grounding.
  | 'still-listed'

export interface AlertGroundingRejection {
  alert: JudgeAlert
  reason: AlertGroundingReason
  detail: string
}

interface AlertGroundingResult {
  accepted: JudgeAlert[]
  rejected: AlertGroundingRejection[]
}

/** Canonical numeric tokens: "7.50" and "7.5" ground the same value. */
export function numericTokens(text: string): Set<string> {
  const normalized = text.replace(/,(?=\d)/g, '').replace(/\$\s*/g, '')
  const tokens = new Set<string>()
  for (const m of normalized.matchAll(/\d+(?:\.\d+)?/g)) tokens.add(String(Number(m[0])))
  return tokens
}

const TIMESTAMP =
  /(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g
const CLOCK = /(?<![\d:.])(\d{1,2}:\d{2}(?::\d{2})?)(?![\d:])/g

/** "9:33" and "09:33" are one time of day; seconds kept when given. */
const clockKey = (clock: string) => clock.replace(/^(\d):/, '0$1:')

/**
 * Times of day in `text`, and `text` without them. Every record carries ISO
 * fetch stamps, so their digits would otherwise ground almost any number
 * under 60. A timestamp's date stays in the text, where its parts still
 * ground a printed date; its clock grounds only a clock in the alert.
 */
function splitClocks(text: string): { rest: string; clocks: Set<string> } {
  const clocks = new Set<string>()
  const keep = (clock: string) => {
    const key = clockKey(clock)
    clocks.add(key)
    // "09:33:47" also grounds the "09:33" an alert would print.
    if (key.length > 5) clocks.add(key.slice(0, 5))
  }
  const rest = text
    .replace(TIMESTAMP, (_, date: string, clock: string) => {
      keep(clock)
      return date
    })
    .replace(CLOCK, (_, clock: string) => {
      keep(clock)
      return ' '
    })
  return { rest, clocks }
}

/** Identifier words joined by "-", "." or "/" that carry a digit, lowercased. */
function slugLikeTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/\b[a-z][a-z0-9]*(?:[-./][a-z0-9]+)+\b/g)) {
    if (/\d/.test(m[0]!)) tokens.add(m[0]!)
  }
  return tokens
}

function quotedSpans(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
}

/**
 * A quoted span grounds if it appears verbatim, or does once trailing
 * punctuation is dropped: English puts the comma inside the closing quote,
 * which lost three real alerts (issue #23).
 */
function spanIsGrounded(span: string, corpusLower: string): boolean {
  const lower = span.toLowerCase()
  if (corpusLower.includes(lower)) return true
  const trimmed = lower.replace(/[,.;:!?]+$/, '')
  return trimmed.length > 0 && corpusLower.includes(trimmed)
}

/**
 * Versions a slug spells with a dash, read as the dotted number a headline
 * prints: claude-opus-5-5 → 5.5. Records carry only the slug, so without this
 * a flagship price-cut alert was rejected as an invented number (issue #54).
 * Only slugs count, so a date's "2026-10" never grounds 2026.1.
 */
function slugVersions(text: string): Set<string> {
  const versions = new Set<string>()
  for (const slug of slugLikeTokens(text)) {
    for (const m of slug.matchAll(/(?<![\d.])(\d+)-(\d+)(?![\d.])/g)) {
      versions.add(String(Number(`${m[1]}.${m[2]}`)))
    }
  }
  return versions
}

/** The only text an alert may draw values from. */
export function corpusOf(changes: readonly ChangeRow[]): string {
  return changes
    .map((c) => [c.entity_key, c.before_json ?? '', c.after_json ?? ''].join('\n'))
    .join('\n')
}

/**
 * Why `text` fails grounding against `corpus` (the cited records' text), or
 * null when it passes: groundAlerts' number and term checks, for any other
 * judged text that must stay inside its records.
 */
export function groundingFailure(
  text: string,
  corpus: string,
): { reason: 'ungrounded-number' | 'ungrounded-term'; detail: string } | null {
  const corpusLower = corpus.toLowerCase()
  const source = splitClocks(corpus)
  const printed = splitClocks(text)
  const corpusNumbers = new Set([...numericTokens(source.rest), ...slugVersions(corpus)])
  const badNumbers = [
    ...[...numericTokens(printed.rest)].filter((n) => !corpusNumbers.has(n)),
    ...[...printed.clocks].filter((c) => !source.clocks.has(c)),
  ]
  if (badNumbers.length > 0) {
    return {
      reason: 'ungrounded-number',
      detail: `number(s) not present in the cited change records: ${badNumbers.join(', ')}`,
    }
  }
  const badTerms = [
    ...[...slugLikeTokens(text)].filter((t) => !corpusLower.includes(t)),
    ...quotedSpans(text)
      .filter((q) => !spanIsGrounded(q, corpusLower))
      .map((q) => `"${q}"`),
  ]
  if (badTerms.length > 0) {
    return {
      reason: 'ungrounded-term',
      detail: `term(s) not present in the cited change records: ${badTerms.join(', ')}`,
    }
  }
  return null
}

export function groundAlerts(
  alerts: readonly JudgeAlert[],
  supplied: readonly ChangeRow[],
): AlertGroundingResult {
  const byId = new Map(supplied.map((c) => [c.id, c]))
  const accepted: JudgeAlert[] = []
  const rejected: AlertGroundingRejection[] = []

  for (const alert of alerts) {
    const unknown = alert.change_ids.filter((id) => !byId.has(id))
    if (unknown.length > 0) {
      rejected.push({
        alert,
        reason: 'unknown-change-id',
        detail: `change_id(s) not among the supplied change records: ${unknown.join(', ')}`,
      })
      continue
    }

    const cited = alert.change_ids.map((id) => byId.get(id)!)
    const failure = groundingFailure(`${alert.headline}\n${alert.explanation}`, corpusOf(cited))
    if (failure) {
      rejected.push({ alert, ...failure })
      continue
    }

    accepted.push(alert)
  }

  return { accepted, rejected }
}
