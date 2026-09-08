import { z } from 'zod'

// Every row in every table carries these two fields. Non-negotiable
// (docs/DECISIONS-takehome.md "Optimizing for"): trustworthiness is the
// depth axis, and a datum a reader cannot re-fetch is a claim, not data.
export const provenanceFields = {
  source_url: z.url({ protocol: /^https?$/ }),
  // ISO 8601 with timezone (Z or offset) — naive timestamps are ambiguous.
  fetched_at: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
      'fetched_at must be ISO 8601 with timezone',
    ),
} as const

export const Provenance = z.object(provenanceFields)
export type Provenance = z.infer<typeof Provenance>
