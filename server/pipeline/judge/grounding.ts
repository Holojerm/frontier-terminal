import type { ChangeRow } from '../contracts'
import type { JudgeAlert } from './contract'

// Grounding check for the judge lane — the deterministic enforcement of the
// explain rule: the model may cite only fields present in the change records
// it was given, or it stays silent. Runs AFTER the schema gate (schema first,
// then literalism). An alert survives only if
//   1. every change_id names a change row actually supplied (unknown id ->
//      the whole alert is rejected),
//   2. every number printed in headline+explanation appears in the cited
//      rows' before_json/after_json/entity_key ("$" and thousands-commas
//      stripped, numeric value compared — "$7.50" grounds 7.5; a derived
//      figure like "-33%" does not),
//   3. every slug-like token carrying a digit ("grok-4.6", "gemini-2.5-pro",
//      "s-1") and every "double-quoted span" (how the prompt tells the model
//      to cite job titles) appears verbatim, case-insensitively, in them.
// Rejection is silence, not repair: a rejected alert is never inserted.
// Deliberately coarse — a tripwire against invention, not a re-judging.
//
// Ported unchanged from the take-home's alert-grounding.ts, including the
// digit requirement on slugs: without it "near-term", "cost-per-token" and
// "input/output" rejected every live model output measured (3/3 runs,
// 2026-08-25). A tripwire that fires on ordinary prose is not a tripwire.

export type AlertGroundingReason = 'unknown-change-id' | 'ungrounded-number' | 'ungrounded-term'

export interface AlertGroundingRejection {
  alert: JudgeAlert
  reason: AlertGroundingReason
  detail: string
}

export interface AlertGroundingResult {
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

/** Identifier words joined by "-", "." or "/" that carry a digit, lowercased. */
export function slugLikeTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/\b[a-z][a-z0-9]*(?:[-./][a-z0-9]+)+\b/g)) {
    if (/\d/.test(m[0]!)) tokens.add(m[0]!)
  }
  return tokens
}

export function quotedSpans(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
}

/** The only text an alert may draw values from. */
function corpusOf(changes: readonly ChangeRow[]): string {
  return changes
    .map((c) => [c.entity_key, c.before_json ?? '', c.after_json ?? ''].join('\n'))
    .join('\n')
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
    const corpus = corpusOf(cited)
    const corpusLower = corpus.toLowerCase()
    const corpusNumbers = numericTokens(corpus)
    const text = `${alert.headline}\n${alert.explanation}`

    const badNumbers = [...numericTokens(text)].filter((n) => !corpusNumbers.has(n))
    if (badNumbers.length > 0) {
      rejected.push({
        alert,
        reason: 'ungrounded-number',
        detail: `number(s) not present in the cited change records: ${badNumbers.join(', ')}`,
      })
      continue
    }

    const badTerms = [
      ...[...slugLikeTokens(text)].filter((t) => !corpusLower.includes(t)),
      ...quotedSpans(text)
        .filter((q) => !corpusLower.includes(q.toLowerCase()))
        .map((q) => `"${q}"`),
    ]
    if (badTerms.length > 0) {
      rejected.push({
        alert,
        reason: 'ungrounded-term',
        detail: `term(s) not present in the cited change records: ${badTerms.join(', ')}`,
      })
      continue
    }

    accepted.push(alert)
  }

  return { accepted, rejected }
}
