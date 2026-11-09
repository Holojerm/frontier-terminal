import { and, eq, inArray } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { ChangeRow } from '../contracts'
import type { PipelineDb } from '../store'
import type { AlertGroundingRejection } from './grounding'
import type { JudgeAlert } from './contract'

// A model that one page of a lab stopped listing while another page of the
// same lab still lists it has not been delisted. Each catalog is a set lane
// (lane-removals.ts), so a row that leaves the page is logged as `removed`,
// and a removal reads like a withdrawal. On 2026-11-09 Anthropic's models
// overview dropped claude-fable-5-1 from its table when claude-fable-5-2
// launched. The pricing page still listed it at the same prices, and the
// API still served it, but the judge wrote "Anthropic delists
// claude-fable-5-1, launches claude-fable-5-2 and claude-mythos-5-2".
//
// Two halves, the same split as the hiring floor:
//   - GET /api/judge/pending hands the judge, per pending model removal, the
//     pages that still list that model (the STILL LISTED block), so it can
//     write "drops claude-fable-5-1 from its models overview" instead.
//   - POST /api/judge/alerts binds it: an alert whose sentence names a
//     still-listed model next to a delisting word is rejected, and an
//     alert that cites nothing but such removals is stored as `info`
//     (severity-gates.ts). Both read the store at submit time.
//
// "Still listed" is read from `entities`, the current rows of every source:
// the same provider and model_slug on any page, any tier. A removal whose
// model no page lists any more is a real delisting and passes untouched.

export interface StillListedRemoval {
  change_id: string
  provider: string
  model_slug: string
  /** The page that stopped listing it: the removal's own source_url. */
  removed_from: string
  /** Every page that lists the model now, with the tiers it lists. */
  listed_on: { source_url: string; tiers: string[] }[]
}

interface ModelPayload {
  model_slug?: unknown
  tier?: unknown
}

const removedSlug = (change: ChangeRow): string | null => {
  if (change.entity_type !== 'model' || change.change_type !== 'removed') return null
  if (!change.before_json) return null
  const slug = (JSON.parse(change.before_json) as ModelPayload).model_slug
  return typeof slug === 'string' ? slug : null
}

/** The model removals among `changes` that some page of the same lab still lists. */
export async function stillListedRemovals(
  db: PipelineDb,
  changes: readonly ChangeRow[],
): Promise<StillListedRemoval[]> {
  const removals = changes.flatMap((change) => {
    const slug = removedSlug(change)
    return slug ? [{ change, slug }] : []
  })
  if (removals.length === 0) return []
  const providers = [...new Set(removals.map((r) => r.change.provider))]
  const rows = await db
    .select({
      provider: tables.entities.provider,
      payload: tables.entities.payload,
      source_url: tables.entities.source_url,
    })
    .from(tables.entities)
    .where(
      and(eq(tables.entities.entity_type, 'model'), inArray(tables.entities.provider, providers)),
    )
  // provider:slug -> source_url -> tiers
  const listings = new Map<string, Map<string, Set<string>>>()
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as ModelPayload
    if (typeof payload.model_slug !== 'string') continue
    const key = `${row.provider}:${payload.model_slug}`
    const pages = listings.get(key) ?? new Map<string, Set<string>>()
    const tiers = pages.get(row.source_url) ?? new Set<string>()
    tiers.add(typeof payload.tier === 'string' ? payload.tier : 'standard')
    pages.set(row.source_url, tiers)
    listings.set(key, pages)
  }
  return removals.flatMap(({ change, slug }) => {
    const pages = listings.get(`${change.provider}:${slug}`)
    if (!pages) return []
    return [
      {
        change_id: change.id,
        provider: change.provider,
        model_slug: slug,
        removed_from: change.source_url,
        listed_on: [...pages]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([source_url, tiers]) => ({ source_url, tiers: [...tiers].sort() })),
      },
    ]
  })
}

/**
 * Words that say a model was withdrawn rather than dropped from one page,
 * each with the root that grounds it when a cited record uses it (null:
 * a phrase no record grounds). Deliberately coarse, like grounding: a
 * tripwire on the words that misled, not a reading of the sentence.
 * "removes" and "drops" alone are not here: "drops claude-fable-5-1 from its
 * models overview" is the accurate sentence. A removal put on the whole
 * catalog or the API is.
 */
const DELISTING: readonly { pattern: RegExp; root: string | null }[] = [
  { pattern: /\bde-?list\w*/g, root: 'delist' },
  { pattern: /\bwithdr[ae]w\w*/g, root: 'withdr' },
  { pattern: /\bretir\w*/g, root: 'retir' },
  { pattern: /\bdiscontinu\w*/g, root: 'discontinu' },
  { pattern: /\bsunset\w*/g, root: 'sunset' },
  { pattern: /\bdeprecat\w*/g, root: 'deprecat' },
  { pattern: /\bno longer (?:offer|sell|sold|serv|availab|list)\w*/g, root: null },
  { pattern: /\bcatalog(?:ue)? (?:remov|drop)\w*/g, root: null },
  {
    pattern:
      /\b(?:remov|drop|pull)\w*\b[^.;\n]{0,80}?\bfrom (?:\S+ ){0,3}(?:catalog(?:ue)?|lineup|line-up|api|price list)\b/g,
    root: null,
  },
]

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * How a sentence may spell a slug, as one pattern over the lowercased text:
 * "claude-fable-5-1", "Claude Fable 5.1" and "Fable 5.1" (a vendor prefix
 * dropped) all name claude-fable-5-1, "claude-fable-5-1-mini" does not.
 */
export function slugPattern(slug: string): RegExp {
  const tokens = slug.toLowerCase().split(/[-.]/)
  const spell = (parts: readonly string[]) =>
    parts
      .map((part, i) => {
        if (i === 0) return escapeRegex(part)
        const numeric = /^\d+$/.test(part) && /^\d+$/.test(parts[i - 1]!)
        return `${numeric ? '[-.]' : '[-.\\s]'}${escapeRegex(part)}`
      })
      .join('')
  const forms = [spell(tokens)]
  // "gpt-5" stays whole: dropping its prefix would leave a bare number.
  if (tokens.length > 2) forms.push(spell(tokens.slice(1)))
  return new RegExp(`(?<![a-z0-9.-])(?:${forms.join('|')})(?![a-z0-9]|[-.][a-z0-9])`)
}

const sentences = (text: string) => text.split(/[.;!?](?=\s|$)|\n+/)

/**
 * A delisting word in the same sentence as a still-listed model, or null.
 * A word passes when a cited record itself uses it: a vendor note saying a
 * model is deprecated grounds "deprecated", as a record value grounds a
 * number.
 */
export function falseDelisting(
  text: string,
  slugs: readonly string[],
  corpus: string,
): { slug: string; word: string } | null {
  const corpusLower = corpus.toLowerCase()
  const patterns = slugs.map((slug) => ({ slug, pattern: slugPattern(slug) }))
  for (const sentence of sentences(text)) {
    const lower = sentence.toLowerCase()
    const named = patterns.find((p) => p.pattern.test(lower))
    if (!named) continue
    for (const { pattern, root } of DELISTING) {
      for (const m of lower.matchAll(pattern)) {
        if (root === null || !corpusLower.includes(root)) return { slug: named.slug, word: m[0] }
      }
    }
  }
  return null
}

/**
 * Reject every alert that calls a still-listed model delisted. Rejection is
 * silence, as for grounding: the launch half of such an alert is already
 * carried by the model-floor rule, and a wrong word on the alert tier is
 * worse than no alert.
 */
export function rejectFalseDelistings(
  alerts: readonly JudgeAlert[],
  cited: readonly ChangeRow[],
  stillListed: readonly StillListedRemoval[],
): { accepted: JudgeAlert[]; rejected: AlertGroundingRejection[] } {
  const byChange = new Map(stillListed.map((r) => [r.change_id, r]))
  const byId = new Map(cited.map((c) => [c.id, c]))
  const accepted: JudgeAlert[] = []
  const rejected: AlertGroundingRejection[] = []
  for (const alert of alerts) {
    const removals = alert.change_ids.flatMap((id) => byChange.get(id) ?? [])
    if (removals.length === 0) {
      accepted.push(alert)
      continue
    }
    const corpus = alert.change_ids
      .flatMap((id) => byId.get(id) ?? [])
      .map((c) => `${c.before_json ?? ''}\n${c.after_json ?? ''}`)
      .join('\n')
    const hit = falseDelisting(
      `${alert.headline}\n${alert.explanation}`,
      removals.map((r) => r.model_slug),
      corpus,
    )
    if (!hit) {
      accepted.push(alert)
      continue
    }
    const removal = removals.find((r) => r.model_slug === hit.slug)!
    rejected.push({
      alert,
      reason: 'still-listed',
      detail:
        `"${hit.word}" about ${hit.slug}, which only ${removal.removed_from} stopped listing; ` +
        `still listed on ${removal.listed_on.map((p) => p.source_url).join(', ')}`,
    })
  }
  return { accepted, rejected }
}
