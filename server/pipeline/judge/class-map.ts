import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

import type { BigFour, ModelClassId } from '#shared/utils/terminal-types'

import * as tables from '../../db/schema'
import { recordOpsEvent } from '../../utils/ops'
import { CLASS_MAP_SOURCES, type ClassEntry } from '../../utils/terminal-classes'
import { effectiveClassMap } from '../class-map'
import type { SourceRunRow } from '../contracts'
import { flattenMdLinks } from '../recommendations'
import type { PipelineDb } from '../store'

// The judge's second job: re-mapping a like-for-like matrix cell whose vendor
// sentence has left the page. The rule is the one terminal-classes.ts states
// for the hand-written seed — a class is what the vendor's own docs recommend,
// quoted verbatim — and the Worker enforces it the way grounding.ts enforces
// the explain rule: the model proposes, deterministic checks decide, and a
// rejection is silence plus an ops event, never a repair.
//
// A proposal is accepted only if ALL of these hold:
//   1. the cell is under review: its drift check (recommendations.ts) found
//      the current sentence gone within REVIEW_WINDOW_MS. A cell whose
//      sentence is still on the page is never re-mapped, whatever the model
//      thinks of a newer model — "start here" is the vendor's call;
//   2. basis_source_id is that provider's class-map page (CLASS_MAP_SOURCES);
//   3. the basis sentence is on that page verbatim — the newest good stored
//      snapshot, links flattened — the same substring rule as the drift check;
//   4. model_slug is a model this store currently lists for the provider;
//   5. the sentence names that model and no other listed one (its slug, case
//      and punctuation folded: "Claude Opus 5.5" names claude-opus-5-5, never
//      claude-opus-5 — modelNamedBy) or IS that model's catalog description
//      (Anthropic's compare table describes, it does not name);
//   6. it differs from the mapping in effect.
// The written row's provenance is the snapshot the sentence was found in.

/** How long after its sentence disappears a cell is offered for re-mapping. */
export const REVIEW_WINDOW_MS = 48 * 60 * 60 * 1000

/** The largest page the review hands the judge; a models page is ~20 KB. */
const MAX_PAGE_CHARS = 120_000

/** One re-mapping as the model prints it. Everything else is stamped here. */
export const JudgeClassMapping = z.strictObject({
  provider: z.enum(['openai', 'anthropic', 'google', 'xai']),
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

export interface ReviewCell {
  provider: BigFour
  class: ModelClassId
  /** The mapping in effect, whose sentence the last poll did not find. */
  current: Pick<ClassEntry, 'model_slug' | 'basis' | 'basis_source_id'>
  /** When the drift check first reported the sentence gone. */
  stale_since: string
}

/** Cells whose sentence left the page within the window, for the mapping in effect. */
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
  for (const check of checks) {
    const payload = JSON.parse(check.payload) as Record<string, unknown>
    if (payload.present !== false) continue
    if (Date.parse(check.fetched_at) < cutoff) continue
    const entry = classMap.find((e) => e.provider === payload.provider && e.class === payload.class)
    // A check on a slug the map no longer names was about a mapping already replaced.
    if (!entry || entry.model_slug !== payload.model_slug) continue
    out.push({
      provider: entry.provider,
      class: entry.class,
      current: {
        model_slug: entry.model_slug,
        basis: entry.basis,
        basis_source_id: entry.basis_source_id,
      },
      stale_since: check.fetched_at,
    })
  }
  return out.sort((a, b) => `${a.provider}:${a.class}`.localeCompare(`${b.provider}:${b.class}`))
}

export interface ClassMapReview {
  cells: ReviewCell[]
  /** The page each cell rests on, once per source. */
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
  for (const sourceId of new Set(cells.map((c) => CLASS_MAP_SOURCES[c.provider]))) {
    if (!sourceId) continue
    const page = await latestPage(db, readRaw, sourceId)
    if (page) pages.push({ ...page, text: page.text.slice(0, MAX_PAGE_CHARS) })
  }
  return { cells, pages }
}

/** Lowercased, every run of non-alphanumerics folded to one "-". */
function fold(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
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
  | 'wrong-source'
  | 'no-page'
  | 'basis-not-on-page'
  | 'unknown-model'
  | 'basis-does-not-name-model'
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
    if (typeof payload.notes === 'string') notes.add(payload.notes.trim())
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
  const rejected: ClassMapRejection[] = []
  const decided = new Set<string>()
  let accepted = 0

  for (const mapping of proposals) {
    const cell = `${mapping.provider}:${mapping.class}`
    const reject = (reason: ClassMapRejectionReason, detail: string) =>
      rejected.push({ mapping, reason, detail })

    if (decided.has(cell) || !review.some((r) => `${r.provider}:${r.class}` === cell)) {
      reject('not-under-review', `${cell} is not awaiting a new mapping`)
      continue
    }
    const expected = CLASS_MAP_SOURCES[mapping.provider]
    if (!expected || mapping.basis_source_id !== expected) {
      const page = expected ?? 'no page'
      reject('wrong-source', `${cell} rests on ${page}, not ${mapping.basis_source_id}`)
      continue
    }
    if (!pages.has(expected)) pages.set(expected, await latestPage(db, readRaw, expected))
    const page = pages.get(expected)!
    if (!page) {
      reject('no-page', `no stored snapshot of ${expected}`)
      continue
    }
    if (!page.text.includes(mapping.basis)) {
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
    if (
      modelNamedBy(mapping.basis, listed.keys()) !== mapping.model_slug &&
      !descriptions.has(mapping.basis.trim())
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
