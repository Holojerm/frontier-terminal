// Cron task: the weekly thesis digest, Monday 13:00 UTC (layers/terminal/server/theses/digest.ts).
// Mailed through the same send_email binding as the ops digest; with no
// binding configured it logs and returns, like ops:alert. A send that fails
// throws, and withHeartbeat spools it as task_failed, so the next ops digest
// says the weekly one did not go out.

import { db } from '@nuxthub/db'
import { and, eq, gte } from 'drizzle-orm'

import sourcesYaml from 'raw:~~/sources.yaml'

import * as tables from '#server/db/schema'
import { DIGEST_DAYS, buildThesisDigest } from '../../theses/digest'
import { getOpsMailer } from '#server/utils/ops-mail'
import { terminalStamps } from '../../utils/terminal-cache'
import { queryContext } from '../../utils/terminal-db'
import { queryTheses } from '../../utils/terminal-theses'
import { withHeartbeat } from '../../utils/task-heartbeat'

interface CloudflareTaskContext {
  cloudflare?: { env?: Record<string, unknown> }
}

const task = defineTask({
  meta: {
    name: 'theses:digest',
    description: 'Email the weekly thesis digest: claim statuses, moves, verdicts, confirmations',
  },
  async run({ context }) {
    const env = (context as CloudflareTaskContext | undefined)?.cloudflare?.env
    const mailer = getOpsMailer(env)
    if (!mailer) {
      console.warn(JSON.stringify({ kind: 'thesis_digest_unconfigured' }))
      return { result: { skipped: 'unconfigured' } }
    }
    const now = new Date()
    const since = new Date(now.getTime() - DIGEST_DAYS * 86_400_000).toISOString()
    const [data, changes, failedRuns] = await Promise.all([
      queryTheses(
        db,
        queryContext(sourcesYaml, (await terminalStamps(db)).poll, () => now),
      ),
      db
        .select()
        .from(tables.claimStatusChanges)
        .where(gte(tables.claimStatusChanges.changed_at, since)),
      db
        .select({
          recipe_id: tables.recipeRuns.recipe_id,
          started_at: tables.recipeRuns.started_at,
          detail: tables.recipeRuns.detail,
        })
        .from(tables.recipeRuns)
        .where(
          and(eq(tables.recipeRuns.status, 'failed'), gte(tables.recipeRuns.started_at, since)),
        ),
    ])
    const { appName, appUrl } = useRuntimeConfig().public
    const digest = buildThesisDigest({ data, changes, failedRuns, now, appName, appUrl })
    await mailer({ ...digest, ids: [] })
    return { result: { sent: true, subject: digest.subject } }
  },
})

export default withHeartbeat(task)
