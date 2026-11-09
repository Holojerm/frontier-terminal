// Cron task: the weekly thesis digest, Monday 13:00 UTC (layers/terminal/server/theses/digest.ts).
// The owner's copy goes through the OWNER_EMAIL send_email binding; with no
// binding configured it is skipped. Confirmed subscribers get the public copy
// through Resend, and only when NUXT_RESEND_API_KEY and the from address are set.
// A send that fails throws, and withHeartbeat spools it as task_failed, which
// the fleet dashboard reports.

import { db } from '@nuxthub/db'

import { getIdentitySalt } from '#server/utils/identity'

import { buildThesisDigest } from '../../theses/digest'
import { loadDigestInput } from '../../utils/digest-input'
import { getOwnerMailer } from '../../utils/owner-mail'
import { subscribeConfig } from '../../utils/subscribe-config'
import { sendSubscriberDigest } from '../../utils/subscriber-mail'
import { purgeStalePending } from '../../utils/subscribers'
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
    const mailer = getOwnerMailer(env)
    const config = useRuntimeConfig()
    const subscribe = subscribeConfig(config as Parameters<typeof subscribeConfig>[0])
    if (!mailer && !subscribe) {
      console.warn(JSON.stringify({ kind: 'thesis_digest_unconfigured' }))
      return { result: { skipped: 'unconfigured' } }
    }
    const input = await loadDigestInput(new Date())
    const { appName, appUrl } = config.public
    const result: Record<string, unknown> = {}

    if (mailer) {
      const digest = buildThesisDigest({ ...input, appName, appUrl })
      await mailer(digest)
      result.sent = true
      result.subject = digest.subject
    }

    if (subscribe) {
      const purged = await purgeStalePending(db, input.now)
      const fan = await sendSubscriberDigest(db, subscribe, await getIdentitySalt(db), {
        ...input,
        appName,
        appUrl: subscribe.appUrl,
      })
      result.subscribers = { ...fan, purged }
      if (fan.failedBatches > 0) {
        throw new Error(
          `subscriber digest: ${fan.failedBatches} batch(es) failed, ${fan.sent}/${fan.recipients} sent`,
        )
      }
    }
    return { result }
  },
})

export default withHeartbeat(task)
