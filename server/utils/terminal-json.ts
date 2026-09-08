// Reading stored payloads. A row's payload / before_json / after_json is JSON
// text the parsers wrote; these helpers read one field out of it without ever
// guessing a value — an absent or mistyped field is null, never a default.
//
// Shared by terminal-db.ts (the queries) and terminal-history.ts (the pure
// derivations over rows), so the two agree on what a field is.

import type { FieldDiff } from '#shared/utils/terminal-types'

export type Json = Record<string, unknown>

export function parseJson(text: string | null): Json | null {
  if (text === null) return null
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Json)
      : null
  } catch {
    return null
  }
}

export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
export const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

export const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const scalar = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : JSON.stringify(v)

/** Every field of either payload, sorted by name, with both sides as scalars. */
export function fieldTable(before: Json | null, after: Json | null): FieldDiff[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort(
    byString,
  )
  return keys.map((field) => ({
    field,
    before: before ? scalar(before[field]) : null,
    after: after ? scalar(after[field]) : null,
  }))
}

/** Fields whose value differs between the two payloads, sorted by name. */
export function fieldDiff(before: Json | null, after: Json | null): FieldDiff[] {
  if (!before || !after) return []
  return fieldTable(before, after).filter((d) => d.before !== d.after)
}
