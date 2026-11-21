// Starts the GDELT Actions job (.github/workflows/gdelt-search.yml) from the
// Worker's cron. GitHub's own schedule for it drops most triggers: 4 runs
// from 2026-11-19 to 2026-11-21 03:30Z against ~48 a day asked for, with
// 6–9 hour gaps (and earlier, issues #301 and #323). Cloudflare's cron fires
// on time, so the Worker asks GitHub for a run every half hour and the
// workflow's schedule stays as the fallback.
//
// A dispatch while a run is going only queues behind it: the workflow's
// concurrency group never cancels a running job, and GitHub keeps one
// pending run per group, so a busy hour collapses to back-to-back runs.
//
// Needs NUXT_GITHUB_DISPATCH_TOKEN, a fine-grained token on this one
// repository with Actions: read and write. Not NUXT_GITHUB_TOKEN, which only
// needs to read public repositories and is sent to the search API. Unset, the
// task does nothing and the schedule alone starts the job. A refused or failed
// dispatch spools GDELT_DISPATCH_FAILED_KIND; nothing here sends mail.

import { recordOpsEvent } from '#server/utils/ops'

import type { PipelineDb } from '../store'
import { repoSlug } from '../reliability/deploys'

export const GDELT_WORKFLOW = 'gdelt-search.yml'
export const GDELT_DISPATCH_FAILED_KIND = 'gdelt_dispatch_failed'
const USER_AGENT = 'frontier-terminal-gdelt-dispatch (+https://frontierterm.com/data)'

export function dispatchUrl(slug: string): string {
  return `https://api.github.com/repos/${slug}/actions/workflows/${GDELT_WORKFLOW}/dispatches`
}

export type DispatchReport =
  | { status: 'dispatched' }
  | { status: 'unconfigured' }
  | { status: 'no-repo' }
  | { status: 'failed'; detail: string }

/** Ask GitHub for one run of the GDELT job on main. Never throws over a GitHub failure. */
export async function dispatchGdeltSearch(
  db: PipelineDb,
  deps: {
    fetch: typeof fetch
    /** fleet.json links.github. */
    repoUrl: string
    /** NUXT_GITHUB_DISPATCH_TOKEN. */
    token?: string
  },
): Promise<DispatchReport> {
  const token = deps.token?.trim()
  if (!token) return { status: 'unconfigured' }
  const slug = repoSlug(deps.repoUrl)
  if (!slug) return { status: 'no-repo' }

  let detail: string
  try {
    const response = await deps.fetch(dispatchUrl(slug), {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': USER_AGENT,
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ref: 'main' }),
      signal: AbortSignal.timeout(20_000),
    })
    if (response.ok) return { status: 'dispatched' }
    detail = `GitHub answered ${response.status}${await githubMessage(response)}`
  } catch (error) {
    detail = String(error)
  }
  await recordOpsEvent(db, {
    kind: GDELT_DISPATCH_FAILED_KIND,
    detail: `${GDELT_WORKFLOW} dispatch: ${detail}`,
  })
  return { status: 'failed', detail }
}

/** GitHub's `message` field, which names a bad token or a missing permission. */
async function githubMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown }
    return typeof body.message === 'string' ? `: ${body.message.slice(0, 200)}` : ''
  } catch {
    return ''
  }
}
