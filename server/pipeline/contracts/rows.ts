import { z } from 'zod'
import { provenanceFields } from './provenance'

// One zod schema per store table (snapshots, entities, changes, alerts).
// The row schema is the contract; whatever persistence layer lands must
// mirror it, and every insert path validates against it first.

export const providerEnum = z.enum(['openai', 'anthropic', 'google', 'xai', 'other'])
export const entityTypeEnum = z.enum(['job', 'model', 'filing'])
export const changeTypeEnum = z.enum(['added', 'removed', 'modified'])
export const severityEnum = z.enum(['info', 'notable', 'critical'])
export const alertRuleEnum = z.enum(['agent-judge', 's1-floor'])

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
  raw_path: z.string().min(1), // where the stored payload lives
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

export const tableSchemas = {
  snapshots: SnapshotRow,
  entities: EntityRow,
  changes: ChangeRow,
  alerts: AlertRow,
} as const

export type TableName = keyof typeof tableSchemas
