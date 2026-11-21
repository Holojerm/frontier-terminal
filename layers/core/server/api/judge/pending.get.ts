// GET /api/judge/pending — the change rows the judge routine has not seen,
// plus the prompt to judge them with. Bearer NUXT_JUDGE_TOKEN
// (layers/core/server/utils/judge-auth.ts); 404 when unset, 401 on mismatch.
//
// The prompt travels in the response so the routine judges with the prompt
// this deploy shipped, whatever commit its own checkout happens to be on —
// one prompt, versioned here. Every block after `limit` is a registry entry
// (server/registries/judge.ts): JUDGE_CONTEXT's, then each JUDGE_REVIEWS offer. `changes` are the oldest pending first, and
// `through` is the cursor POST /api/judge/alerts accepts for them. Empty `changes` with no cell in
// `class_map_review` is the common case and the routine's signal to stop.
// `class_map_review` lists the price-matrix cells whose vendor sentence left
// the page, and the empty cells of a lab that just launched a model, with
// that page's text to map them from
// (layers/pricing/server/pipeline/judge/class-map.ts). `claim_review` lists, per judged
// thesis claim, the pending changes it offers for a verdict
// (layers/theses/server/theses/verdicts.ts): events among `changes`, and recipe items
// (a changelog entry, say) not yet rated, so it can be non-empty when
// `changes` is empty. `hiring` gives, per lab with job changes pending, the
// board and department sizes and which moves clear the materiality floor
// that POST /api/judge/alerts enforces (layers/talent/server/pipeline/hiring-floor.ts).
// `track_record_review` lists, per material alert, the press articles and
// newsroom posts found around it that still need a same-event rating
// (layers/press/server/pipeline/track-record/review.ts); like
// `claim_review`, it can be non-empty when `changes` is empty.
// `figure_review` lists press headlines that state a lab's revenue,
// valuation or funding and are not yet read
// (layers/press/server/pipeline/reported/review.ts); it too can be
// non-empty when `changes` is empty.
// `filing_review` lists fresh registration filings whose revenue or cover
// terms the parser could not read, with the document text to read them from
// (layers/companies/server/pipeline/judge/filing-review.ts); usually `[]`, and
// it too can be non-empty when `changes` is empty.
// `price_review` lists the price lists whose parser is failing, each with its
// page and the SKUs to read from it (layers/pricing/server/pipeline/judge/price-review.ts);
// usually `[]`, and it too can be non-empty when `changes` is empty.
// `still_listed` lists, per model removal among `changes`, the pages of the
// same lab that still list that model, so a page dropping a row is not
// written up as a delisting (layers/core/server/pipeline/judge/still-listed.ts);
// usually `[]`.
// `supplier_review` lists the suppliers' new SEC documents that name a lab, a
// cloud or a customer share, each with excerpts and the rows already held for
// that company (layers/companies/server/suppliers/review.ts); it too can be
// non-empty when `changes` is empty.
// `power_site_review` lists the SEC documents EDGAR full-text search found
// naming one of Epoch's lab sites and speaking of power near it, each with
// excerpts and the ties already held for that site
// (layers/compute/server/power/review.ts); likewise.
// `guidance_review` lists the call transcripts, remarks and replays the
// guidance parser found no figure in but that have sentences looking ahead
// with a figure, each with those sentences (layers/companies/server/calls/review.ts);
// likewise.

import { blob } from '@nuxthub/blob'
import { db } from '@nuxthub/db'

import judgePrompt from 'raw:../../pipeline/judge/judge-explain.prompt.md'
import sourcesYaml from 'raw:~~/sources.yaml'

import { JUDGE_CONTEXT, JUDGE_REVIEWS } from '#server/registries/judge'
import { blobRawReader } from '../../pipeline/raw'
import { JUDGE_CHANGE_LIMIT, pendingChanges } from '../../pipeline/judge/pending'
import type { JudgeContextEntry } from '../../pipeline/judge/review'
import { requireJudgeToken } from '../../utils/judge-auth'

/** The context blocks, then every review's offer, in registry order. */
const BLOCKS: readonly JudgeContextEntry[] = [
  ...JUDGE_CONTEXT,
  ...JUDGE_REVIEWS.flatMap((r) => (r.offer ? [r.offer] : [])),
]

export default defineEventHandler(async (event) => {
  await rateLimit(event, { name: 'judge', limit: 30, windowSeconds: 60 })
  setResponseHeader(event, 'Cache-Control', 'no-store')
  await requireJudgeToken(event)

  const { changes, total_pending, since, through } = await pendingChanges(db, JUDGE_CHANGE_LIMIT)
  const ctx = { db, readRaw: blobRawReader(blob), changes, sourcesYaml, now: new Date() }
  const blocks = await Promise.all(BLOCKS.map((b) => b.read(ctx)))
  return {
    schema: 1,
    changes,
    total_pending,
    since,
    // The judged_through to send back: the newest detected_at among `changes`.
    through,
    limit: JUDGE_CHANGE_LIMIT,
    ...Object.fromEntries(BLOCKS.map((b, i) => [b.key, blocks[i]])),
    prompt: judgePrompt,
  }
})
