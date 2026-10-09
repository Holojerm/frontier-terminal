// Cron task: the weekly thesis digest, Monday 13:00 UTC (server/theses/digest.ts).
// Mailed through the same send_email binding as the ops digest; with no
// binding configured it logs and returns, like ops:alert. A send that fails
// is spooled as an ops event, so the next ops digest says the weekly one
// did not go out.

import { db } from '@nuxthub/db'
import { gte } from 'drizzle-orm'

import sourcesYaml from 'raw:../../../sources.yaml'

import * as tables from '../../db/schema'
import { DIGEST_DAYS, buildThesisDigest } from '../../theses/digest'
import { recordOpsEvent } from '../../utils/ops'
import { getOpsMailer } from '../../utils/ops-mail'
import { terminalStamp } from '../../utils/terminal-cache'
import { queryContext } from '../../utils/terminal-db'
import { queryTheses } from '../../utils/terminal-theses'

interface CloudflareTaskContext {
  cloudflare?: { env?: Record<string, unknown> }
}

export default defineTask({
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
    const [data, changes] = await Promise.all([
      queryTheses(
        db,
        queryContext(sourcesYaml, await terminalStamp(db), () => now),
      ),
      db
        .select()
        .from(tables.claimStatusChanges)
        .where(gte(tables.claimStatusChanges.changed_at, since)),
    ])
    const { appName, appUrl } = useRuntimeConfig().public
    const digest = buildThesisDigest({ data, changes, now, appName, appUrl })
    try {
      await mailer({ ...digest, ids: [] })
    } catch (error) {
      await recordOpsEvent(db, { kind: 'thesis_digest_failed', detail: String(error) })
      return { result: { sent: false } }
    }
    return { result: { sent: true, subject: digest.subject } }
  },
})
