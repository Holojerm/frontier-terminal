// The hand-read side of the call reader (curated/earnings-calls.json): for each listed
// company, what it posts for its calls and why it posts nothing we can read, and each
// transcript, set of remarks or replay on its own hosts. The reader finds EDGAR exhibits.

import { z } from 'zod'

import curatedJson from '../curated/earnings-calls.json'

const POSTS = ['transcript', 'remarks', 'webcast', 'none'] as const

const Speaker = z.strictObject({ name: z.string().min(1), title: z.string().min(1) })

export const CallCompany = z.strictObject({
  ticker: z.string().regex(/^[A-Z]{1,5}$/),
  company: z.string().min(1),
  cik: z.string().regex(/^\d{10}$/),
  /**
   * The registrant's earlier CIK, for a company that redomiciled: its
   * earnings filings until `until` are read, and its XBRL scores them.
   */
  prior_cik: z
    .strictObject({
      cik: z.string().regex(/^\d{10}$/),
      until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .optional(),
  /**
   * The registrant's filings before this are another business's (a reverse
   * merger, a divested parent), so no call before it is read.
   */
  history_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Exhibits a subsidiary files under the parent's CIK, by file name or description. */
  skip_exhibits: z.string().min(1).optional(),
  /** The calendar month the fiscal year ends in. */
  fy_end_month: z.number().int().min(1).max(12),
  posts: z.enum(POSTS),
  ir_url: z.string().url(),
  terms_url: z.string().url().nullable(),
  /** Why some of its calls can't be read, in a sentence or two; null when none. */
  gap: z.string().min(1).nullable(),
  speakers: Speaker.array().optional(),
  keyterms: z.string().min(1).array().optional(),
  prompt: z.string().min(1).optional(),
})
export type CallCompany = z.infer<typeof CallCompany>

const CuratedDocument = z.strictObject({
  ticker: z.string(),
  call_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(['transcript', 'remarks', 'audio']),
  url: z.string().url(),
  page_url: z.string().url(),
  produced_by: z.string().nullable(),
  /** An AssemblyAI job submitted from the mini for the backfill: the Worker collects it. */
  job_id: z.string().uuid().optional(),
  submitted_at: z.string().optional(),
  /** What the mini costed the job at before submitting it, counted on its basis until collected. */
  estimate_usd: z.number().nonnegative().optional(),
})
export type CuratedDocument = z.infer<typeof CuratedDocument>

export const CuratedCalls = z.strictObject({
  _comment: z.string(),
  companies: CallCompany.array(),
  documents: CuratedDocument.array(),
})

export const curatedCalls = CuratedCalls.parse(curatedJson)

export const CALL_COMPANIES: ReadonlyMap<string, CallCompany> = new Map(
  curatedCalls.companies.map((c) => [c.ticker, c]),
)

export const CALL_TICKERS = curatedCalls.companies.map((c) => c.ticker)

export function callCompany(ticker: string): CallCompany {
  const c = CALL_COMPANIES.get(ticker)
  if (!c) throw new Error(`no call company ${ticker}`)
  return c
}
