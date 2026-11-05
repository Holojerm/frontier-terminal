// Each production deploy's smoke-test result, read from GitHub. The
// post-deploy-smoke workflow (.github/workflows/post-deploy-smoke.yml) runs on
// every push to main and fails when production doesn't serve that commit or
// serves it broken. The repo is public, so its runs are readable without a
// token: no secret, and no write path into the site.
//
// One read returns the last 100 runs, so a read GitHub refuses loses nothing:
// the next good read fills the gap. Refusals are the normal case without a
// token. The unauthenticated REST limit is 60 an hour per IP, Workers share
// egress IPs with every other tenant, and the first production read
// (2026-11-05 06:41) got a 403 with the hour's budget already spent. So the
// read runs on the five-minute tick, goes out at most once per READ_EVERY_MS
// once one succeeds, parks until GitHub's reset after a 403 or 429, and sends
// the stored ETag (a 304 doesn't count against the limit). NUXT_GITHUB_TOKEN,
// when set, authenticates the read (5,000 an hour, per token); any token
// that can read public repositories will do.

import { sql } from 'drizzle-orm'

import * as tables from '#server/db/schema'
import { chunk, rowsPerStatement, runStatements, type PipelineDb } from '../store'

export const SMOKE_WORKFLOW = 'post-deploy-smoke.yml'
export const GITHUB_USER_AGENT =
  'frontier-terminal-reliability (+https://frontierterm.com/data#reliability)'

const ETAG_KEY = 'reliability:github:etag'
const BACKOFF_KEY = 'reliability:github:backoff-until'
const NEXT_KEY = 'reliability:github:next-read'
/** How often a read goes out once one has succeeded. */
export const READ_EVERY_MS = 55 * 60 * 1000
/** How soon a read that failed outright (a timeout, a 5xx) is tried again. */
const RETRY_FAILED_MS = 15 * 60 * 1000
/** Longest a refused read parks the next ones, when GitHub names no reset time. */
const DEFAULT_BACKOFF_MS = 60 * 60 * 1000

/** "owner/repo" from the repo's GitHub URL (fleet.json links.github). */
export function repoSlug(repoUrl: string): string | null {
  return repoUrl.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] ?? null
}

export function workflowRunsUrl(slug: string): string {
  return `https://api.github.com/repos/${slug}/actions/workflows/${SMOKE_WORKFLOW}/runs?branch=main&per_page=100`
}

export function workflowPageUrl(repoUrl: string): string {
  return `${repoUrl.replace(/\/$/, '')}/actions/workflows/${SMOKE_WORKFLOW}?query=branch%3Amain`
}

export interface DeployCheckRow {
  run_id: string
  head_sha: string
  status: string
  conclusion: string | null
  created_at: string
  updated_at: string
  html_url: string
  source_url: string
  fetched_at: string
}

interface WorkflowRun {
  id?: unknown
  head_sha?: unknown
  head_branch?: unknown
  status?: unknown
  conclusion?: unknown
  created_at?: unknown
  updated_at?: unknown
  html_url?: unknown
}

const iso = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null

/** The runs on main in one page of GitHub's workflow-runs response. A run missing a field is skipped. */
export function parseWorkflowRuns(
  body: unknown,
  prov: { source_url: string; fetched_at: string },
): DeployCheckRow[] {
  const runs = (body as { workflow_runs?: WorkflowRun[] } | null)?.workflow_runs
  if (!Array.isArray(runs)) throw new Error('GitHub response has no workflow_runs array')
  const out: DeployCheckRow[] = []
  for (const run of runs) {
    const created = iso(run.created_at)
    const updated = iso(run.updated_at)
    if (
      (typeof run.id !== 'number' && typeof run.id !== 'string') ||
      typeof run.head_sha !== 'string' ||
      !/^[0-9a-f]{40}$/.test(run.head_sha) ||
      run.head_branch !== 'main' ||
      typeof run.status !== 'string' ||
      typeof run.html_url !== 'string' ||
      !run.html_url.startsWith('https://github.com/') ||
      !created ||
      !updated
    ) {
      continue
    }
    out.push({
      run_id: String(run.id),
      head_sha: run.head_sha,
      status: run.status,
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
      created_at: created,
      updated_at: updated,
      html_url: run.html_url,
      ...prov,
    })
  }
  return out
}

/** The slice of the KV store this needs; tests pass a Map-backed fake. */
export interface ReliabilityKv {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, opts?: { ttl?: number }): Promise<unknown>
}

export type DeployReport =
  | { status: 'stored'; runs: number }
  | { status: 'not-modified' }
  | { status: 'not-due'; next: string }
  | { status: 'parked'; until: string }
  | { status: 'rate-limited'; until: string }
  | { status: 'failed'; detail: string }
  | { status: 'no-repo' }

/** When a refused read may be tried again: GitHub's reset time, its Retry-After, or an hour. */
export function backoffUntil(headers: Headers, now: Date): string {
  const reset = Number(headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset * 1000 > now.getTime()) {
    return new Date(reset * 1000).toISOString()
  }
  const retry = Number(headers.get('retry-after'))
  if (Number.isFinite(retry) && retry > 0) {
    return new Date(now.getTime() + retry * 1000).toISOString()
  }
  return new Date(now.getTime() + DEFAULT_BACKOFF_MS).toISOString()
}

/** Read the smoke workflow's runs on main and upsert them. Never throws over a GitHub failure. */
export async function recordDeployChecks(
  db: PipelineDb,
  deps: {
    fetch: typeof fetch
    kv: ReliabilityKv
    now: Date
    repoUrl: string
    /** NUXT_GITHUB_TOKEN; empty reads unauthenticated. */
    token?: string
  },
): Promise<DeployReport> {
  const slug = repoSlug(deps.repoUrl)
  if (!slug) return { status: 'no-repo' }
  const nowIso = deps.now.toISOString()
  const parked = await deps.kv.get(BACKOFF_KEY)
  if (typeof parked === 'string' && parked > nowIso) return { status: 'parked', until: parked }
  const next = await deps.kv.get(NEXT_KEY)
  if (typeof next === 'string' && next > nowIso) return { status: 'not-due', next }
  const schedule = (ms: number) => {
    const at = new Date(deps.now.getTime() + ms).toISOString()
    return deps.kv.set(NEXT_KEY, at, { ttl: Math.ceil(ms / 1000) })
  }

  const url = workflowRunsUrl(slug)
  // An ETag is only worth sending for rows we still hold; a 304 to an empty table would keep it empty.
  const [held] = await db
    .select({ id: tables.deployChecks.run_id })
    .from(tables.deployChecks)
    .limit(1)
  const etag = held ? await deps.kv.get(ETAG_KEY) : null
  let response: Response
  try {
    response = await deps.fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': GITHUB_USER_AGENT,
        ...(deps.token ? { authorization: `Bearer ${deps.token}` } : {}),
        ...(typeof etag === 'string' ? { 'if-none-match': etag } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    await schedule(RETRY_FAILED_MS)
    return { status: 'failed', detail: String(error) }
  }
  if (response.status === 304) {
    // Nothing changed, but the rows were read now.
    await db.update(tables.deployChecks).set({ fetched_at: nowIso })
    await schedule(READ_EVERY_MS)
    return { status: 'not-modified' }
  }
  if (response.status === 403 || response.status === 429) {
    const until = backoffUntil(response.headers, deps.now)
    const ttl = Math.max(60, Math.ceil((Date.parse(until) - deps.now.getTime()) / 1000))
    await deps.kv.set(BACKOFF_KEY, until, { ttl })
    return { status: 'rate-limited', until }
  }
  if (!response.ok) {
    await schedule(RETRY_FAILED_MS)
    return { status: 'failed', detail: `GitHub answered ${response.status}` }
  }

  const rows = parseWorkflowRuns(await response.json(), { source_url: url, fetched_at: nowIso })
  await runStatements(
    db,
    chunk(rows, rowsPerStatement(9)).map((group) =>
      db
        .insert(tables.deployChecks)
        .values(group)
        .onConflictDoUpdate({
          target: tables.deployChecks.run_id,
          set: {
            status: sql`excluded.status`,
            conclusion: sql`excluded.conclusion`,
            updated_at: sql`excluded.updated_at`,
            source_url: sql`excluded.source_url`,
            fetched_at: sql`excluded.fetched_at`,
          },
        }),
    ),
  )
  // Stored only after the rows are: an ETag for a page not written would 304 the retry.
  const tag = response.headers.get('etag')
  if (tag) await deps.kv.set(ETAG_KEY, tag, { ttl: 7 * 24 * 3600 })
  await schedule(READ_EVERY_MS)
  return { status: 'stored', runs: rows.length }
}
