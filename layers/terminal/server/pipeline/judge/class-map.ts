import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import { z } from 'zod'

import type { LabId, ModelClassId } from '../../../shared/utils/terminal-types'

import * as tables from '#server/db/schema'
import { catalogDescription } from '../parsers/pricing/anthropic-models-overview'
import { recordOpsEvent } from '#server/utils/ops'
import {
  CLASS_GAPS,
  CLASS_MAP_SOURCES,
  MODEL_CLASSES,
  type ClassEntry,
} from '../../utils/terminal-classes'
import { effectiveClassMap } from '../class-map'
import type { SourceRunRow } from '../contracts'
import { MODEL_FLOOR_RULE } from '../model-floor'
import { basisOnPage, flattenMdLinks } from '../recommendations'
import { cardDescriptions, cardOwners, type CardDescriptions } from './page-cards'
import type { PipelineDb } from '../store'

// The judge's second job: re-mapping a like-for-like matrix cell whose vendor
// sentence has left the page. The rule is the one terminal-classes.ts states
// for the hand-written seed — a class is what the vendor's own docs recommend,
// quoted verbatim — and the Worker enforces it the way grounding.ts enforces
// the explain rule: the model proposes, deterministic checks decide, and a
// rejection is silence plus an ops event, never a repair.
//
// A cell is under review in one of two ways. Its drift check
// (recommendations.ts) found the current sentence gone within
// REVIEW_WINDOW_MS. Or it is a gap (no mapping, CLASS_GAPS says why) and the
// provider launched a model within REVIEW_WINDOW_MS: a launch is when a vendor
// writes the sentence a gap lacked. Gemini 4 Hydrogen was listed on
// 2026-11-12 with a card that answers Google's balanced column, and nothing
// offered that cell to anyone, because only a mapped cell has a sentence to
// lose. A gap re-opened by a launch may be filled only with a launched model:
// the older models were weighed when the gap was written.
//
// A proposal is accepted only if ALL of these hold:
//   1. the cell is under review, as above. A cell whose sentence is still on
//      the page is never re-mapped, whatever the model thinks of a newer
//      model — "start here" is the vendor's call. A gap re-opened by a launch
//      takes only a model the launch listed;
//   2. basis_source_id is one of that provider's class-map pages
//      (CLASS_MAP_SOURCES);
//   3. the basis sentence is on that page verbatim — the newest good stored
//      snapshot, links flattened — the same substring rule as the drift check;
//   4. model_slug is a model this store currently lists for the provider;
//   5. the sentence names that model and no other listed one (its slug, case
//      and punctuation folded: "Claude Opus 5.5" names claude-opus-5-5, never
//      claude-opus-5 — modelNamedBy) or IS that model's catalog description
//      (Anthropic's compare table describes, it does not name) or the
//      description on that model's own card on the page (Google's and
//      Alibaba's cards, page-cards.ts: their stored rows carry pricing notes,
//      not descriptions);
//   6. the sentence is not ANOTHER model's card description. A card is about
//      its own model, whatever it mentions: Argon's card compares Argon to
//      Carbon, which the naming rule in 5 reads as naming Carbon (cardOwners);
//   7. it differs from the mapping in effect.
// The written row's provenance is the snapshot the sentence was found in.

/** How long after its sentence disappears a cell is offered for re-mapping. */
export const REVIEW_WINDOW_MS = 48 * 60 * 60 * 1000

/** The largest page the review hands the judge; a models page is ~20 KB. */
const MAX_PAGE_CHARS = 120_000

/** One re-mapping as the model prints it. Everything else is stamped here. */
export const JudgeClassMapping = z.strictObject({
  provider: z.enum([
    'openai',
    'anthropic',
    'google',
    'xai',
    'meta',
    'mistral',
    'deepseek',
    'alibaba',
    'moonshot',
  ]),
  class: z.enum(['flagship', 'balanced', 'economy']),
  model_slug: z.string().min(1).max(100),
  basis: z.string().min(1).max(500),
  basis_source_id: z.string().min(1).max(100),
})
export type JudgeClassMapping = z.infer<typeof JudgeClassMapping>

export interface SourcePage {
  source_id: string
  source_url: string
  fetched_at: string
  /** The stored bytes with markdown links flattened to their text. */
  text: string
}

/** Reads an R2 object's text; null when it is not there. */
export type RawReader = (key: string) => Promise<string | null>

/** NuxtHub's `blob` (or anything with its get signature) as a RawReader. */
export function blobRawReader(blob: {
  get(key: string): Promise<{ text(): Promise<string> } | null>
}): RawReader {
  return async (key) => {
    const object = await blob.get(key)
    return object ? object.text() : null
  }
}

/** The newest good snapshot of a source, as text — what the drift check last read. */
export async function latestPage(
  db: PipelineDb,
  readRaw: RawReader,
  sourceId: string,
): Promise<SourcePage | null> {
  const good: SourceRunRow['status'][] = ['ok', 'unchanged', 'baseline']
  const [row] = await db
    .select({
      raw_key: tables.snapshots.raw_key,
      source_url: tables.snapshots.source_url,
      fetched_at: tables.snapshots.fetched_at,
    })
    .from(tables.sourceRuns)
    .innerJoin(tables.snapshots, eq(tables.snapshots.id, tables.sourceRuns.snapshot_id))
    .where(and(eq(tables.sourceRuns.source_id, sourceId), inArray(tables.sourceRuns.status, good)))
    .orderBy(desc(tables.sourceRuns.started_at))
    .limit(1)
  if (!row) return null
  const text = await readRaw(row.raw_key)
  if (text === null) return null
  return {
    source_id: sourceId,
    source_url: row.source_url,
    fetched_at: row.fetched_at,
    text: flattenMdLinks(text),
  }
}

export type ReviewCell =
  | {
      provider: LabId
      class: ModelClassId
      reason: 'basis-gone'
      /** The mapping in effect, whose sentence the last poll did not find. */
      current: Pick<ClassEntry, 'model_slug' | 'basis' | 'basis_source_id'>
      /** When the drift check first reported the sentence gone. */
      since: string
    }
  | {
      provider: LabId
      class: ModelClassId
      reason: 'launch-into-gap'
      current: null
      /** Why the cell had no mapping (CLASS_GAPS), as the matrix shows it. */
      gap: string | null
      /** The models the provider launched in the window, the only ones the cell may take. */
      launched: string[]
      /** When the first of them was listed. */
      since: string
    }

/** `provider -> slug -> first listed`, for every model-floor launch since `cutoff`. */
async function launchesSince(
  db: PipelineDb,
  cutoff: string,
): Promise<Map<string, Map<string, string>>> {
  const alerts = await db
    .select({ change_ids: tables.alerts.change_ids, created_at: tables.alerts.created_at })
    .from(tables.alerts)
    .where(and(eq(tables.alerts.rule, MODEL_FLOOR_RULE), gte(tables.alerts.created_at, cutoff)))
  const listedAt = new Map<string, string>()
  for (const alert of alerts) {
    const ids = JSON.parse(alert.change_ids) as unknown
    if (Array.isArray(ids) && typeof ids[0] === 'string') listedAt.set(ids[0], alert.created_at)
  }
  const out = new Map<string, Map<string, string>>()
  if (listedAt.size === 0) return out
  const changes = await db
    .select({
      id: tables.changes.id,
      provider: tables.changes.provider,
      after_json: tables.changes.after_json,
    })
    .from(tables.changes)
    .where(inArray(tables.changes.id, [...listedAt.keys()]))
  for (const change of changes) {
    const slug = (JSON.parse(change.after_json ?? '{}') as { model_slug?: unknown }).model_slug
    if (typeof slug !== 'string') continue
    const slugs = out.get(change.provider) ?? new Map<string, string>()
    slugs.set(slug, listedAt.get(change.id)!)
    out.set(change.provider, slugs)
  }
  return out
}

/**
 * Cells offered for a new mapping: those whose sentence left the page within
 * the window, for the mapping in effect, and the gaps of a provider that
 * launched a model within it.
 */
export async function cellsUnderReview(
  db: PipelineDb,
  classMap: readonly ClassEntry[],
  now: Date,
): Promise<ReviewCell[]> {
  const checks = await db
    .select({ payload: tables.entities.payload, fetched_at: tables.entities.fetched_at })
    .from(tables.entities)
    .where(eq(tables.entities.entity_type, 'recommendation'))
  const cutoff = now.getTime() - REVIEW_WINDOW_MS
  const out: ReviewCell[] = []
  for (const [provider, slugs] of await launchesSince(db, new Date(cutoff).toISOString())) {
    // A provider with no class-map page has nowhere a sentence could come from.
    if (!CLASS_MAP_SOURCES[provider as LabId]?.length) continue
    const since = [...slugs.values()].sort()[0]!
    for (const klass of MODEL_CLASSES) {
      if (classMap.some((e) => e.provider === provider && e.class === klass.id)) continue
      const gap = CLASS_GAPS.find((g) => g.provider === provider && g.class === klass.id)
      out.push({
        provider: provider as LabId,
        class: klass.id,
        reason: 'launch-into-gap',
        current: null,
        gap: gap?.reason ?? null,
        launched: [...slugs.keys()].sort(),
        since,
      })
    }
  }
  for (const check of checks) {
    const payload = JSON.parse(check.payload) as Record<string, unknown>
    if (payload.present !== false) continue
    if (Date.parse(check.fetched_at) < cutoff) continue
    const entry = classMap.find((e) => e.provider === payload.provider && e.class === payload.class)
    // A check on a slug or sentence the map no longer holds was about a mapping already replaced.
    if (!entry || entry.model_slug !== payload.model_slug || entry.basis !== payload.basis) continue
    out.push({
      provider: entry.provider,
      class: entry.class,
      reason: 'basis-gone',
      current: {
        model_slug: entry.model_slug,
        basis: entry.basis,
        basis_source_id: entry.basis_source_id,
      },
      since: check.fetched_at,
    })
  }
  return out.sort((a, b) => `${a.provider}:${a.class}`.localeCompare(`${b.provider}:${b.class}`))
}

export interface ClassMapReview {
  cells: ReviewCell[]
  /** The pages each cell's provider may cite, once per source. */
  pages: SourcePage[]
}

/** What GET /api/judge/pending adds: the cells to re-map and the pages to re-map them from. */
export async function classMapReview(
  db: PipelineDb,
  readRaw: RawReader,
  now: Date = new Date(),
): Promise<ClassMapReview> {
  const cells = await cellsUnderReview(db, await effectiveClassMap(db), now)
  const pages: SourcePage[] = []
  for (const sourceId of new Set(cells.flatMap((c) => CLASS_MAP_SOURCES[c.provider] ?? []))) {
    const page = await latestPage(db, readRaw, sourceId)
    if (page) pages.push({ ...page, text: page.text.slice(0, MAX_PAGE_CHARS) })
  }
  return { cells, pages }
}

/** Lowercased, every run of non-alphanumerics folded to one "-". */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * True when the sentence names the slug as a whole run of name tokens that no
 * version number continues: "Claude Opus 5.5" names claude-opus-5-5, and does
 * NOT name claude-opus-5.
 */
export function basisNamesModel(basis: string, slug: string): boolean {
  const text = `-${fold(basis)}-`
  const needle = `-${fold(slug)}-`
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    if (!/^\d/.test(text.slice(at + needle.length))) return true
  }
  return false
}

/**
 * The slug a sentence names, among a provider's listed models: of the named
 * ones, the one no longer named slug extends — "GPT-6 Astra" names gpt-6-astra
 * even when a bare gpt-6 is also listed. Null when it names none.
 */
export function modelNamedBy(basis: string, slugs: Iterable<string>): string | null {
  const named = [...slugs].filter((slug) => basisNamesModel(basis, slug))
  const outermost = named.filter(
    (slug) => !named.some((other) => other !== slug && fold(other).includes(fold(slug))),
  )
  return outermost.length === 1 ? outermost[0]! : null
}

export type ClassMapRejectionReason =
  | 'not-under-review'
  | 'not-a-launched-model'
  | 'wrong-source'
  | 'no-page'
  | 'basis-not-on-page'
  | 'unknown-model'
  | 'basis-does-not-name-model'
  | 'basis-is-another-models-card'
  | 'unchanged'

export interface ClassMapRejection {
  mapping: JudgeClassMapping
  reason: ClassMapRejectionReason
  detail: string
}

export interface ClassMapResult {
  accepted: number
  rejected: ClassMapRejection[]
}

export const CLASS_MAP_OPS_PATH = '/api/judge/alerts'

/** The provider's current model rows: slug -> catalog descriptions printed for it. */
async function listedModels(db: PipelineDb, provider: string): Promise<Map<string, Set<string>>> {
  const rows = await db
    .select({ payload: tables.entities.payload })
    .from(tables.entities)
    .where(and(eq(tables.entities.entity_type, 'model'), eq(tables.entities.provider, provider)))
  const out = new Map<string, Set<string>>()
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as { model_slug?: unknown; notes?: unknown }
    if (typeof payload.model_slug !== 'string') continue
    const notes = out.get(payload.model_slug) ?? new Set<string>()
    // A row's notes are its catalog description, plus any note the parser
    // appended (a "From" price); only the description is the vendor's sentence.
    if (typeof payload.notes === 'string') notes.add(catalogDescription(payload.notes))
    out.set(payload.model_slug, notes)
  }
  return out
}

/**
 * Gate every proposed mapping and write the ones that pass. Never throws for a
 * proposal: each rejection is a return value and one ops event per run.
 */
export async function applyClassMappings(
  db: PipelineDb,
  readRaw: RawReader,
  proposals: readonly JudgeClassMapping[],
  now: Date = new Date(),
): Promise<ClassMapResult> {
  if (proposals.length === 0) return { accepted: 0, rejected: [] }

  const classMap = await effectiveClassMap(db)
  const review = await cellsUnderReview(db, classMap, now)
  const pages = new Map<string, SourcePage | null>()
  const models = new Map<string, Map<string, Set<string>>>()
  const cards = new Map<string, CardDescriptions>()
  const rejected: ClassMapRejection[] = []
  const decided = new Set<string>()
  let accepted = 0

  for (const mapping of proposals) {
    const cell = `${mapping.provider}:${mapping.class}`
    const reject = (reason: ClassMapRejectionReason, detail: string) =>
      rejected.push({ mapping, reason, detail })

    const under = review.find((r) => `${r.provider}:${r.class}` === cell)
    if (decided.has(cell) || !under) {
      reject('not-under-review', `${cell} is not awaiting a new mapping`)
      continue
    }
    if (under.reason === 'launch-into-gap' && !under.launched.includes(mapping.model_slug)) {
      reject(
        'not-a-launched-model',
        `${cell} was re-opened by the launch of ${under.launched.join(', ')}, not ${mapping.model_slug}`,
      )
      continue
    }
    const allowed = CLASS_MAP_SOURCES[mapping.provider] ?? []
    if (!allowed.includes(mapping.basis_source_id)) {
      const pagesFor = allowed.length ? allowed.join(' or ') : 'no page'
      reject('wrong-source', `${cell} rests on ${pagesFor}, not ${mapping.basis_source_id}`)
      continue
    }
    const expected = mapping.basis_source_id
    if (!pages.has(expected)) pages.set(expected, await latestPage(db, readRaw, expected))
    const page = pages.get(expected)!
    if (!page) {
      reject('no-page', `no stored snapshot of ${expected}`)
      continue
    }
    if (!basisOnPage(page.text, mapping.basis)) {
      reject('basis-not-on-page', `sentence not found verbatim on ${expected}`)
      continue
    }
    if (!models.has(mapping.provider)) {
      models.set(mapping.provider, await listedModels(db, mapping.provider))
    }
    const listed = models.get(mapping.provider)!
    const descriptions = listed.get(mapping.model_slug)
    if (!descriptions) {
      const who = mapping.provider
      reject('unknown-model', `${mapping.model_slug} is not a ${who} model in the store`)
      continue
    }
    if (!cards.has(expected)) cards.set(expected, cardDescriptions(expected, page.text))
    const owners = cardOwners(cards.get(expected)!, mapping.basis)
    const onCard = owners.includes(mapping.model_slug)
    if (owners.length > 0 && !onCard) {
      reject(
        'basis-is-another-models-card',
        `the sentence is the description on ${owners.join(', ')}'s card, not ${mapping.model_slug}'s`,
      )
      continue
    }
    if (
      modelNamedBy(mapping.basis, listed.keys()) !== mapping.model_slug &&
      !descriptions.has(mapping.basis.trim()) &&
      !onCard
    ) {
      reject(
        'basis-does-not-name-model',
        `the sentence neither names ${mapping.model_slug} nor is its catalog description`,
      )
      continue
    }
    const current = classMap.find(
      (e) => e.provider === mapping.provider && e.class === mapping.class,
    )
    if (current?.model_slug === mapping.model_slug && current.basis === mapping.basis) {
      reject('unchanged', `${cell} already rests on this sentence`)
      continue
    }

    await db.insert(tables.classMapDecisions).values({
      id: crypto.randomUUID(),
      provider: mapping.provider,
      class: mapping.class,
      model_slug: mapping.model_slug,
      basis: mapping.basis,
      basis_source_id: expected,
      decided_at: now.toISOString(),
      decided_by: 'judge',
      source_url: page.source_url,
      fetched_at: page.fetched_at,
    })
    await recordOpsEvent(db, {
      kind: 'class_map_changed',
      detail: `${cell}: ${current?.model_slug ?? '(gap)'} -> ${mapping.model_slug}: "${mapping.basis}"`,
      path: CLASS_MAP_OPS_PATH,
    })
    decided.add(cell)
    accepted++
  }

  if (rejected.length > 0) {
    const [first] = rejected
    await recordOpsEvent(db, {
      kind: 'judge_rejected',
      detail: `${rejected.length} class-map proposal(s) rejected; first: ${first!.reason}: ${first!.detail}`,
      path: CLASS_MAP_OPS_PATH,
    })
  }
  return { accepted, rejected }
}
