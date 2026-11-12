// The saved copy of a page behind a snapshot, for systematic licensees
// (GET /export/payloads/<snapshot id>).
//
// Only for sources whose sources.yaml `rights` is `ours`: facts a publisher
// states about itself, read under terms and a robots.txt that allow it. A
// `restricted` source's rows can be licensed as our compilation, but the page
// is the publisher's and its terms restrict reading it, so we don't hand the
// bytes on. A `not-cleared` source stays out of anything sold, and an
// `upstream` dataset travels under its own license, not ours. None of the
// three is served here whatever the key. A derived source (a model page, an
// EDGAR filing index) takes the rights of the source it was derived from.

import { eq } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import type { SourceRights } from '../../shared/utils/terminal-types'
import type { PipelineDb } from '../pipeline/store'
import { DERIVED_TERMS_FROM, derivedTemplateOf, type SourceRegistry } from './terminal-sources'

/** A snapshot id: `<source_id>:<fetched_at>`. */
const SNAPSHOT_ID =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

export function isSnapshotId(value: string): boolean {
  return SNAPSHOT_ID.test(value)
}

/** The rights a source's bytes are held under, or null when sources.yaml doesn't say. */
export function sourceRights(registry: SourceRegistry, sourceId: string): SourceRights | null {
  const own = registry.sources.find((s) => s.source_id === sourceId)
  if (own) return own.rights
  const template = derivedTemplateOf(sourceId)
  if (!template) return null
  return registry.sources.find((s) => s.yaml_id === DERIVED_TERMS_FROM[template])?.rights ?? null
}

/** Why a source's saved pages aren't served, or null when they are. */
export function payloadRefusal(rights: SourceRights | null): string | null {
  if (rights === 'ours') return null
  if (rights === 'upstream') {
    return 'This source is someone else’s dataset under its own license, so we don’t serve its saved pages. Its license and URL are in the coverage table on /data.'
  }
  if (rights === 'restricted') {
    return 'This publisher’s terms restrict automated reading of its pages. A license covers our compilation of the rows, not the saved pages, so they stay off the licensed feed.'
  }
  if (rights === 'not-cleared') {
    return 'This source isn’t cleared for any paid offer (no stated license, unread terms, or a robots or terms restriction), so its saved pages stay off the licensed feed.'
  }
  return 'sources.yaml states no rights for this source, so its saved pages aren’t served.'
}

export interface PayloadSnapshot {
  id: string
  source_id: string
  content_hash: string
  raw_key: string
  source_url: string
  fetched_at: string
}

export async function snapshotById(db: PipelineDb, id: string): Promise<PayloadSnapshot | null> {
  const [row] = await db
    .select({
      id: tables.snapshots.id,
      source_id: tables.snapshots.source_id,
      content_hash: tables.snapshots.content_hash,
      raw_key: tables.snapshots.raw_key,
      source_url: tables.snapshots.source_url,
      fetched_at: tables.snapshots.fetched_at,
    })
    .from(tables.snapshots)
    .where(eq(tables.snapshots.id, id))
    .limit(1)
  return row ?? null
}
