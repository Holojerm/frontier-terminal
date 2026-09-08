import { z } from 'zod'
import { provenanceFields } from './provenance'

// One zod schema per store table (snapshots, entities, changes, alerts,
// source_runs). The row schema is the contract; server/db/schema.ts mirrors
// it column for column, and server/pipeline/store.ts validates every row
// against it before D1 sees the row.

export const providerEnum = z.enum(['openai', 'anthropic', 'google', 'xai', 'other'])
// 'ranking' is a time series (one row per UTC day and model), not an event:
// server/pipeline/judge/pending.ts and queryMovement() both exclude it.
export const entityTypeEnum = z.enum(['job', 'model', 'filing', 'incident', 'ranking'])
export const changeTypeEnum = z.enum(['added', 'removed', 'modified'])
export const severityEnum = z.enum(['info', 'notable', 'critical'])
export const alertRuleEnum = z.enum(['agent-judge', 's1-floor'])
// 'skipped': the source needs a credential the deploy does not have, so
// nothing was attempted — distinct from 'failed' so a missing key is a
// configuration state on the coverage panel, not an outage in the digest.
export const sourceRunStatusEnum = z.enum(['ok', 'unchanged', 'failed', 'baseline', 'skipped'])
export const pollScopeEnum = z.enum(['edgar', 'survey'])
export type PollScope = z.infer<typeof pollScopeEnum>

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

const jsonText = z.string().refine(
  (s) => {
    try {
      JSON.parse(s)
      return true
    } catch {
      return false
    }
  },
  { error: 'must be valid JSON text' },
)

export const SnapshotRow = z.strictObject({
  id: z.string().min(1),
  source_id: z.string().min(1), // key into sources.yaml
  content_hash: sha256Hex,
  raw_key: z.string().min(1), // R2 object key of the stored payload
  http_status: z.int().nullable(),
  bytes: z.int().nonnegative().nullable(),
  ...provenanceFields,
})
export type SnapshotRow = z.infer<typeof SnapshotRow>

export const EntityRow = z.strictObject({
  entity_key: z.string().min(1), // jobKey()/modelKey()/filingKey() output
  entity_type: entityTypeEnum,
  provider: providerEnum,
  snapshot_id: z.string().min(1),
  content_hash: sha256Hex,
  payload: jsonText, // normalized record, serialized
  ...provenanceFields,
})
export type EntityRow = z.infer<typeof EntityRow>

// What the entities TABLE holds: the normalize output plus two columns only
// the store can know. source_id scopes the current set (two Anthropic pages
// legitimately emit the same modelKey with different content, so entity_key
// alone cannot be the primary key); first_seen_at is the fetched_at of the
// fetch that first produced the row and is never rewritten.
export const StoredEntityRow = EntityRow.extend({
  source_id: z.string().min(1),
  first_seen_at: provenanceFields.fetched_at,
})
export type StoredEntityRow = z.infer<typeof StoredEntityRow>

export const ChangeRow = z
  .strictObject({
    id: z.string().min(1),
    entity_key: z.string().min(1),
    entity_type: entityTypeEnum,
    provider: providerEnum,
    change_type: changeTypeEnum,
    before_hash: sha256Hex.nullable(), // null iff added
    after_hash: sha256Hex.nullable(), // null iff removed
    before_json: jsonText.nullable(),
    after_json: jsonText.nullable(),
    detected_at: provenanceFields.fetched_at,
    ...provenanceFields,
  })
  .superRefine((row, ctx) => {
    if (row.change_type === 'added' && row.before_hash !== null) {
      ctx.addIssue({ code: 'custom', message: 'added change must have null before_hash' })
    }
    if (row.change_type === 'removed' && row.after_hash !== null) {
      ctx.addIssue({ code: 'custom', message: 'removed change must have null after_hash' })
    }
    if (row.change_type === 'modified' && (row.before_hash === null || row.after_hash === null)) {
      ctx.addIssue({ code: 'custom', message: 'modified change needs both hashes' })
    }
  })
export type ChangeRow = z.infer<typeof ChangeRow>

export const AlertRow = z.strictObject({
  id: z.string().min(1),
  severity: severityEnum,
  headline: z.string().min(1),
  // Grounding rule (boundary table, explain row): explanation may only cite
  // fields present in the referenced change rows.
  explanation: z.string().min(1),
  change_ids: jsonText, // JSON array of changes.id
  rule: alertRuleEnum,
  created_at: provenanceFields.fetched_at,
  ...provenanceFields,
})
export type AlertRow = z.infer<typeof AlertRow>

// One row per (tick, source). The only table without fetched_at, because a
// failed run fetched nothing and a timestamp claiming otherwise would be the
// exact lie the provenance rule exists to prevent; started_at is the tick's
// clock and source_url still names what was attempted.
export const SourceRunRow = z.strictObject({
  id: z.string().min(1),
  scope: pollScopeEnum,
  source_id: z.string().min(1),
  started_at: provenanceFields.fetched_at,
  status: sourceRunStatusEnum,
  detail: z.string().nullable(),
  snapshot_id: z.string().min(1).nullable(), // null iff no fetch succeeded
  added: z.int().nonnegative(),
  removed: z.int().nonnegative(),
  modified: z.int().nonnegative(),
  source_url: provenanceFields.source_url,
})
export type SourceRunRow = z.infer<typeof SourceRunRow>

export const tableSchemas = {
  snapshots: SnapshotRow,
  entities: StoredEntityRow,
  changes: ChangeRow,
  alerts: AlertRow,
  source_runs: SourceRunRow,
} as const

export type TableName = keyof typeof tableSchemas
