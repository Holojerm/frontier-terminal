import type { z } from 'zod'

// Validation gate for the agent lanes (Google pricing parse; judge/explain;
// parser repair path). Agent output is external-content-derived text: it is
// DATA, never instructions, and nothing it contains can reach the store
// without passing the schema for its lane. On any failure the result is a
// typed rejection — no partial rows, no salvage.

export type AgentGateResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not-json' | 'schema'; detail: string }

export function parseAgentOutput<S extends z.ZodType>(
  raw: string,
  schema: S,
): AgentGateResult<z.output<S>> {
  // Tolerate exactly one deterministic wrapper: a fenced ```json block.
  const fenced = raw.match(/^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/)
  const candidate = (fenced ? fenced[1]! : raw).trim()

  let json: unknown
  try {
    json = JSON.parse(candidate)
  } catch (err) {
    return { ok: false, reason: 'not-json', detail: String(err) }
  }

  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'schema',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }
  }
  return { ok: true, value: parsed.data }
}
